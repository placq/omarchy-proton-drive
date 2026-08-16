import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { ConflictError, OfflineError, type DriveEvent, type DriveNode } from "./domain.ts";
import type { DownloadResult, DriveProvider, UploadInput } from "./provider.ts";

interface FakeEntry { node: DriveNode; bytes?: Uint8Array; trashed?: boolean; }

export class FakeDriveProvider implements DriveProvider {
  readonly kind = "fake" as const;
  private entries = new Map<string, FakeEntry>();
  private events: DriveEvent[] = [];
  private eventCounter = 0;
  online = true;

  constructor(seed = true) {
    const now = Date.now();
    this.entries.set("root", { node: { id: "root", parentId: null, name: "Proton Drive", kind: "folder", size: 0, modifiedAt: now, revision: "1" } });
    if (seed) {
      this.addFolder("root", "Documents", "docs");
      this.addFile("docs", "Welcome.txt", new TextEncoder().encode("Omarchy Drive fake provider\n"), "welcome");
    }
  }

  setOnline(value: boolean): void { this.online = value; }
  private assertOnline(): void { if (!this.online) throw new OfflineError(); }
  private entry(id: string): FakeEntry {
    const item = this.entries.get(id);
    if (!item || item.trashed) throw new Error(`Node not found: ${id}`);
    return item;
  }
  private revision(previous?: string): string { return String(Number(previous ?? "0") + 1); }
  private emit(type: DriveEvent["type"], node: DriveNode): void {
    this.events.push({ id: String(++this.eventCounter), type, nodeId: node.id, node: structuredClone(node) });
  }
  addFolder(parentId: string, name: string, id: string = randomUUID()): DriveNode {
    const node: DriveNode = { id, parentId, name, kind: "folder", size: 0, modifiedAt: Date.now(), revision: "1" };
    this.entries.set(id, { node });
    return structuredClone(node);
  }
  addFile(parentId: string, name: string, bytes: Uint8Array, id: string = randomUUID()): DriveNode {
    const node: DriveNode = { id, parentId, name, kind: "file", size: bytes.byteLength, modifiedAt: Date.now(), revision: "1" };
    this.entries.set(id, { node, bytes: Uint8Array.from(bytes) });
    return structuredClone(node);
  }
  remoteEdit(nodeId: string, bytes: Uint8Array): DriveNode {
    const item = this.entry(nodeId);
    item.bytes = Uint8Array.from(bytes);
    item.node = { ...item.node, size: bytes.byteLength, modifiedAt: Date.now(), revision: this.revision(item.node.revision) };
    this.emit("updated", item.node);
    return structuredClone(item.node);
  }
  emitTreeRemoval(): void { this.events.push({ id: "none", type: "refresh", nodeId: "root" }); }
  async getRoot(): Promise<DriveNode> { this.assertOnline(); return structuredClone(this.entry("root").node); }
  async getNode(nodeId: string): Promise<DriveNode> { this.assertOnline(); return structuredClone(this.entry(nodeId).node); }
  async listChildren(parentId: string): Promise<DriveNode[]> {
    this.assertOnline(); this.entry(parentId);
    return [...this.entries.values()].filter(x => !x.trashed && x.node.parentId === parentId).map(x => structuredClone(x.node));
  }
  async downloadToPath(nodeId: string, targetPath: string, onProgress?: (done: number, total: number) => void): Promise<DownloadResult> {
    this.assertOnline(); const item = this.entry(nodeId);
    if (item.node.kind !== "file" || !item.bytes) throw new Error("Not a file");
    await writeFile(targetPath, item.bytes, { mode: 0o600 });
    onProgress?.(item.bytes.byteLength, item.bytes.byteLength);
    return { revision: item.node.revision };
  }
  async readBytes(nodeId: string): Promise<Uint8Array> { const item = this.entry(nodeId); if (!item.bytes) throw new Error("Not a file"); return Uint8Array.from(item.bytes); }
  async upload(input: UploadInput): Promise<DriveNode> {
    this.assertOnline(); this.entry(input.parentId);
    if (input.signal?.aborted) throw new Error("Upload cancelled");
    const bytes = new Uint8Array(await readFile(input.sourcePath));
    if (input.signal?.aborted) throw new Error("Upload cancelled");
    if (input.nodeId) {
      const item = this.entry(input.nodeId);
      if (input.expectedRevision !== undefined && input.expectedRevision !== item.node.revision) throw new ConflictError();
      input.onProgress?.(bytes.byteLength, bytes.byteLength);
      item.bytes = bytes;
      item.node = { ...item.node, name: input.name, size: bytes.byteLength, modifiedAt: input.modifiedAt, revision: this.revision(item.node.revision) };
      this.emit("updated", item.node);
      return structuredClone(item.node);
    }
    const node = this.addFile(input.parentId, input.name, bytes);
    input.onProgress?.(bytes.byteLength, bytes.byteLength);
    this.emit("created", node);
    return node;
  }
  async createFolder(parentId: string, name: string): Promise<DriveNode> { this.assertOnline(); const n = this.addFolder(parentId, name); this.emit("created", n); return n; }
  async rename(nodeId: string, name: string): Promise<DriveNode> {
    this.assertOnline(); const item = this.entry(nodeId); item.node = { ...item.node, name, revision: this.revision(item.node.revision), modifiedAt: Date.now() }; this.emit("updated", item.node); return structuredClone(item.node);
  }
  async move(nodeId: string, parentId: string): Promise<DriveNode> {
    this.assertOnline(); this.entry(parentId); const item = this.entry(nodeId); item.node = { ...item.node, parentId, revision: this.revision(item.node.revision), modifiedAt: Date.now() }; this.emit("moved", item.node); return structuredClone(item.node);
  }
  async trash(nodeId: string): Promise<void> {
    this.assertOnline(); const item = this.entry(nodeId); const ids = [nodeId];
    for (let index = 0; index < ids.length; index += 1) {
      for (const [id, child] of this.entries) if (!child.trashed && child.node.parentId === ids[index]) ids.push(id);
    }
    for (const id of ids) this.entries.get(id)!.trashed = true;
    this.emit("trashed", item.node);
  }
  async *getEvents(afterId?: string): AsyncIterable<DriveEvent> {
    this.assertOnline(); const after = Number(afterId ?? 0);
    for (const event of this.events) {
      if (event.id === "none" || Number(event.id) > after) yield structuredClone(event);
    }
  }
}
