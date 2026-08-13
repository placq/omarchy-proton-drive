import type { DriveEvent, DriveNode } from "./domain.ts";
import type { DownloadResult, DriveProvider, UploadInput } from "./provider.ts";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Writable } from "node:stream";

type StreamWritable = WritableStream<Uint8Array>;
export const PROTON_APP_VERSION = "external-drive-omarchy_drive@0.1.0-alpha";
type SdkNode = Record<string, unknown>;
interface SdkController { completion(): Promise<Record<string, unknown>>; }
interface SdkDriveEvent { type: string; eventId: string; nodeUid?: string; isTrashed?: boolean; }
interface SdkClientLike {
  getMyFilesRootFolder(): Promise<SdkNode>; getNode(uid: string): Promise<SdkNode>;
  iterateFolderChildrenNodeUids(uid: string): AsyncIterable<string>;
  getFileDownloader(uid: string): Promise<{ downloadToStream(stream: WritableStream<Uint8Array>, progress: (n: number) => void): SdkController }>;
  getFileRevisionUploader(uid: string, metadata: Record<string, unknown>): Promise<{ uploadFromStream(stream: ReadableStream<Uint8Array>, thumbnails: unknown[], progress: (n: number) => void): Promise<SdkController> }>;
  getFileUploader(parentUid: string, name: string, metadata: Record<string, unknown>): Promise<{ uploadFromStream(stream: ReadableStream<Uint8Array>, thumbnails: unknown[], progress: (n: number) => void): Promise<SdkController> }>;
  createFolder(parentUid: string, name: string): Promise<SdkNode>; renameNode(uid: string, name: string): Promise<SdkNode>;
  moveNodes(uids: string[], parentUid: string): AsyncIterable<unknown>; trashNodes(uids: string[]): AsyncIterable<unknown>;
  iterateEvents(scopeId: string, lastEventId?: string): AsyncIterable<SdkDriveEvent>;
}

/** Thin adapter only. Authentication and construction of ProtonDriveClient live outside it. */
export class ProtonSdkProvider implements DriveProvider {
  readonly kind = "proton-sdk" as const;
  private eventScopeId?: string;
  constructor(private readonly client: SdkClientLike) {}
  private map(value: SdkNode): DriveNode {
    const activeRevision = value.activeRevision as Record<string, unknown> | undefined;
    return {
      id: String(value.uid), parentId: value.parentUid ? String(value.parentUid) : null, name: String(value.name),
      kind: String(value.type).toLowerCase().includes("folder") ? "folder" : "file",
      size: Number(activeRevision?.size ?? value.size ?? 0), modifiedAt: new Date(String(value.modificationTime ?? Date.now())).getTime(),
      revision: String(activeRevision?.uid ?? value.revisionUid ?? value.uid)
    };
  }
  async getRoot(): Promise<DriveNode> { const raw=await this.client.getMyFilesRootFolder(); this.eventScopeId=String(raw.treeEventScopeId ?? ""); return this.map(raw); }
  async getNode(nodeId: string): Promise<DriveNode> { return this.map(await this.client.getNode(nodeId)); }
  async listChildren(parentId: string): Promise<DriveNode[]> { const out: DriveNode[] = []; for await (const uid of this.client.iterateFolderChildrenNodeUids(parentId)) out.push(this.map(await this.client.getNode(uid))); return out; }
  async downloadToPath(nodeId: string, targetPath: string, onProgress?: (done: number, total: number) => void): Promise<DownloadResult> {
    const node = await this.getNode(nodeId); const sink = Writable.toWeb(createWriteStream(targetPath, { mode: 0o600 })) as StreamWritable;
    const downloader = await this.client.getFileDownloader(nodeId); const controller = downloader.downloadToStream(sink, n => onProgress?.(n, node.size)); await controller.completion();
    return { revision: node.revision };
  }
  async upload(input: UploadInput): Promise<DriveNode> {
    const metadata = { modificationTime: new Date(input.modifiedAt), mediaType: "application/octet-stream", expectedSize: input.expectedSize };
    const uploader = input.nodeId ? await this.client.getFileRevisionUploader(input.nodeId, metadata) : await this.client.getFileUploader(input.parentId, input.name, metadata);
    const stream = Readable.toWeb(createReadStream(input.sourcePath)) as ReadableStream<Uint8Array>;
    const controller = await uploader.uploadFromStream(stream, [], n => input.onProgress?.(n, input.expectedSize)); const result = await controller.completion(); return this.getNode(String(result.nodeUid));
  }
  async createFolder(parentId: string, name: string): Promise<DriveNode> { return this.map(await this.client.createFolder(parentId, name)); }
  async rename(nodeId: string, name: string): Promise<DriveNode> { return this.map(await this.client.renameNode(nodeId, name)); }
  async move(nodeId: string, parentId: string): Promise<DriveNode> { for await (const result of this.client.moveNodes([nodeId], parentId)) { const value = result as unknown as Record<string, unknown>; if (value.error) throw value.error; } return this.getNode(nodeId); }
  async trash(nodeId: string): Promise<void> { for await (const result of this.client.trashNodes([nodeId])) { const value = result as unknown as Record<string, unknown>; if (value.error) throw value.error; } }
  async *getEvents(afterId?: string): AsyncIterable<DriveEvent> {
    if (!this.eventScopeId) await this.getRoot();
    if (!this.eventScopeId) throw new Error("My Files root has no tree event scope");
    for await (const event of this.client.iterateEvents(this.eventScopeId, afterId)) {
      if (event.type === "fast_forward" || event.type === "shared_with_me_updated") { yield { id: event.eventId, type: "cursor", nodeId: "root" }; continue; }
      if (event.type === "tree_refresh" || event.type === "tree_remove") { yield { id: event.eventId, type: "refresh", nodeId: "root" }; continue; }
      if (!event.nodeUid) { yield { id: event.eventId, type: "cursor", nodeId: "root" }; continue; }
      if (event.type === "node_deleted" || event.isTrashed) { yield { id: event.eventId, type: "trashed", nodeId: event.nodeUid }; continue; }
      const node=await this.getNode(event.nodeUid);
      yield { id: event.eventId, type: event.type === "node_created" ? "created" : "updated", nodeId: event.nodeUid, node };
    }
  }
}
