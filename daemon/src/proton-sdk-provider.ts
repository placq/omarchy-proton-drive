import type { DriveEvent, DriveNode } from "./domain.ts";
import type { DownloadResult, DriveProvider, UploadInput } from "./provider.ts";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Writable } from "node:stream";

type StreamWritable = WritableStream<Uint8Array>;
export const PROTON_APP_VERSION = "external-drive-omarchy_drive@1.0.2";
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

function unwrapResult(value: unknown, field: string): string {
  // Proton's public SDK uses Result<T, E> for decrypted fields. Keep the
  // adapter tolerant of older-shaped test fixtures, but never stringify a
  // Result object as "[object Object]".
  if (value && typeof value === "object" && "ok" in value) {
    const result = value as { ok: boolean; value?: unknown; error?: unknown };
    if (!result.ok) throw new Error(`Unable to read node ${field}: ${String(result.error ?? "decryption failed")}`);
    return String(result.value ?? "");
  }
  return String(value ?? "");
}

function dateMillis(value: unknown): number {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  const millis = date.getTime();
  return Number.isFinite(millis) ? millis : Date.now();
}

/** Thin adapter only. Authentication and construction of ProtonDriveClient live outside it. */
export class ProtonSdkProvider implements DriveProvider {
  readonly kind = "proton-sdk" as const;
  private readonly client: SdkClientLike;
  private eventScopeId?: string;
  constructor(client: SdkClientLike) { this.client = client; }
  private map(value: SdkNode): DriveNode {
    const activeRevision = value.activeRevision as Record<string, unknown> | undefined;
    return {
      id: String(value.uid), parentId: value.parentUid ? String(value.parentUid) : null, name: unwrapResult(value.name, "name"),
      kind: String(value.type).toLowerCase().includes("folder") ? "folder" : "file",
      size: Number(activeRevision?.size ?? value.size ?? 0), modifiedAt: dateMillis(value.modificationTime),
      revision: String(activeRevision?.uid ?? value.revisionUid ?? value.uid)
    };
  }
  async getRoot(): Promise<DriveNode> { const raw=await this.client.getMyFilesRootFolder(); this.eventScopeId=String(raw.treeEventScopeId ?? ""); return this.map(raw); }
  async getNode(nodeId: string): Promise<DriveNode> { return this.map(await this.client.getNode(nodeId)); }
  async listChildren(parentId: string): Promise<DriveNode[]> { const out: DriveNode[] = []; for await (const uid of this.client.iterateFolderChildrenNodeUids(parentId)) out.push(this.map(await this.client.getNode(uid))); return out; }
  async downloadToPath(nodeId: string, targetPath: string, onProgress?: (done: number, total: number) => void, knownNode?: DriveNode): Promise<DownloadResult> {
    const node = knownNode ?? await this.getNode(nodeId); const sink = Writable.toWeb(createWriteStream(targetPath, { mode: 0o600 })) as StreamWritable;
    const downloader = await this.client.getFileDownloader(nodeId); const controller = downloader.downloadToStream(sink, n => onProgress?.(n, node.size)); await controller.completion();
    return { revision: node.revision };
  }
  async upload(input: UploadInput): Promise<DriveNode> {
    const metadata = { modificationTime: new Date(input.modifiedAt), mediaType: "application/octet-stream", expectedSize: input.expectedSize };
    const uploader = input.nodeId ? await this.client.getFileRevisionUploader(input.nodeId, metadata) : await this.client.getFileUploader(input.parentId, input.name, metadata);
    const stream = Readable.toWeb(createReadStream(input.sourcePath)) as ReadableStream<Uint8Array>;
    const controller = await uploader.uploadFromStream(stream, [], n => input.onProgress?.(n, input.expectedSize));
    const completion = controller.completion();
    if (input.signal) {
      await Promise.race([
        completion,
        new Promise<never>((_, reject) => input.signal!.addEventListener("abort", () => reject(new Error("Upload cancelled")), { once: true })),
      ]);
    } else {
      await completion;
    }
    return this.getNode(String((await completion).nodeUid));
  }
  async createFolder(parentId: string, name: string, signal?: AbortSignal): Promise<DriveNode> { signal?.throwIfAborted(); return this.map(await this.client.createFolder(parentId, name)); }
  async rename(nodeId: string, name: string, _knownNode?: DriveNode, signal?: AbortSignal): Promise<DriveNode> { signal?.throwIfAborted(); return this.map(await this.client.renameNode(nodeId, name)); }
  async move(nodeId: string, parentId: string, _knownNode?: DriveNode, signal?: AbortSignal): Promise<DriveNode> { signal?.throwIfAborted(); for await (const result of this.client.moveNodes([nodeId], parentId)) { signal?.throwIfAborted(); const value = result as unknown as Record<string, unknown>; if (value.error) throw value.error; } return this.getNode(nodeId); }
  async trash(nodeId: string, signal?: AbortSignal): Promise<void> { signal?.throwIfAborted(); for await (const result of this.client.trashNodes([nodeId])) { signal?.throwIfAborted(); const value = result as unknown as Record<string, unknown>; if (value.error) throw value.error; } }
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
