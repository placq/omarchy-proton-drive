import { copyFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DriveProvider } from "./provider.ts";
import { ConflictError, OfflineError, UnsafeEvictionError, type DriveNode, type NodeState } from "./domain.ts";
import { LocalStorage } from "./local-storage.ts";
import { StateStore } from "./state-store.ts";
import { TransferManager } from "./transfer-manager.ts";

const UNSAFE_EVICTION = new Set(["dirty", "queued", "uploading", "conflict"]);

export class DriveEngine extends EventEmitter {
  readonly transfers = new TransferManager();
  private readonly activeCommits = new Map<string, Promise<NodeState>>();
  private readonly scheduledCommits = new Set<string>();
  private readonly activeDownloads = new Map<string, Promise<string>>();
  constructor(readonly provider: DriveProvider, readonly store: StateStore, readonly storage: LocalStorage) { super(); }

  async initialize(): Promise<void> {
    await Promise.all([this.store.load(), this.storage.initialize()]);
    let changed = false;
    for (const state of this.store.getStates()) {
      const stagingExists = await this.storage.exists(state.stagingPath); const cacheExists = await this.storage.exists(state.cachePath);
      if (state.status === "uploading") {
        state.status = stagingExists ? "queued" : "error";
        state.error = stagingExists ? "Recovered interrupted upload; waiting to retry" : "Interrupted upload has no staging file";
        this.store.setState(state); changed = true;
      } else if (["dirty", "queued", "conflict"].includes(state.status) && !stagingExists) {
        state.status = "error"; state.error = "Persistent staging file is missing"; this.store.setState(state); changed = true;
      } else if (["cached", "pinned"].includes(state.status) && !cacheExists) {
        state.status = "cloud-only"; state.cachePath = undefined; this.store.setState(state); changed = true;
      } else if (state.status === "downloading") {
        state.status = "error"; state.error = "Download was interrupted and can be retried"; this.store.setState(state); changed = true;
      }
    }
    if (changed) await this.store.save();
  }
  private stateFor(node: DriveNode): NodeState {
    return this.store.getState(node.id) ?? { nodeId: node.id, status: "cloud-only", pinned: false, remoteRevision: node.revision, lastAccessedAt: Date.now() };
  }
  private async remember(node: DriveNode, state?: NodeState): Promise<void> {
    this.store.setNode(node); this.store.setState(state ?? this.stateFor(node)); await this.store.save(); this.emit("nodeChanged", node.id);
  }
  async root(): Promise<DriveNode> {
    try { const root = await this.provider.getRoot(); await this.remember(root); return root; }
    catch (e) { const cached = this.store.getNode("root"); if (e instanceof OfflineError && cached) return cached; throw e; }
  }
  async listChildren(parentId: string): Promise<DriveNode[]> {
    try {
      const nodes = await this.provider.listChildren(parentId);
      for (const node of nodes) { this.store.setNode(node); const state = this.stateFor(node); state.remoteRevision = node.revision; this.store.setState(state); }
      await this.store.save(); return nodes;
    } catch (e) {
      if (e instanceof OfflineError) return this.store.getNodes().filter(n => n.parentId === parentId);
      throw e;
    }
  }
  async getNode(nodeId: string): Promise<DriveNode> {
    try { const node = await this.provider.getNode(nodeId); this.store.setNode(node); await this.store.save(); return node; }
    catch (e) { const cached = this.store.getNode(nodeId); if (e instanceof OfflineError && cached) return cached; throw e; }
  }
  getState(nodeId: string): NodeState | undefined { return this.store.getState(nodeId); }
  async materialize(nodeId: string): Promise<string> {
    const active = this.activeDownloads.get(nodeId); if (active) return active;
    const operation = this.performMaterialize(nodeId).finally(() => this.activeDownloads.delete(nodeId));
    this.activeDownloads.set(nodeId, operation); return operation;
  }
  private async performMaterialize(nodeId: string): Promise<string> {
    const node = await this.getNode(nodeId); if (node.kind !== "file") throw new Error("Cannot open a folder as a file");
    const state = this.stateFor(node);
    if (state.cachePath && state.remoteRevision === node.revision && ["cached", "pinned"].includes(state.status)) {
      state.lastAccessedAt = Date.now(); this.store.setState(state); await this.store.save(); return state.cachePath;
    }
    if (state.stagingPath && ["dirty", "queued", "conflict"].includes(state.status)) return state.stagingPath;
    state.status = "downloading"; this.store.setState(state); await this.store.save();
    const transfer = this.transfers.start(node.id, "download", node.name, node.size);
    try {
      const path = this.storage.cachePath(node.id); const temporary = this.storage.downloadPath(node.id);
      await this.storage.remove(temporary);
      const result = await this.provider.downloadToPath(node.id, temporary, (done) => this.transfers.progress(transfer.id, done));
      await this.storage.finalizeDownload(temporary, path);
      state.cachePath = path; state.remoteRevision = result.revision; state.status = state.pinned ? "pinned" : "cached"; state.lastAccessedAt = Date.now();
      this.store.setState(state); await this.store.save(); this.transfers.finish(transfer.id); this.emit("nodeChanged", node.id); return path;
    } catch (e) { state.status = "error"; state.error = e instanceof Error ? e.message : String(e); this.store.setState(state); await this.store.save(); this.transfers.fail(transfer.id, e); throw e; }
  }
  async pin(nodeId: string, pinned: boolean): Promise<NodeState> {
    const node = await this.getNode(nodeId); const state = this.stateFor(node); state.pinned = pinned; this.store.setState(state); await this.store.save();
    if (pinned && node.kind === "file") await this.materialize(nodeId);
    const updated = this.stateFor(node); if (pinned && updated.status === "cached") updated.status = "pinned"; if (!pinned && updated.status === "pinned") updated.status = "cached";
    this.store.setState(updated); await this.store.save(); this.emit("nodeChanged", nodeId); return updated;
  }
  async evict(nodeId: string): Promise<NodeState> {
    const node = await this.getNode(nodeId); const state = this.stateFor(node);
    if (UNSAFE_EVICTION.has(state.status)) throw new UnsafeEvictionError(state.status);
    await this.storage.remove(state.cachePath); state.cachePath = undefined; state.pinned = false; state.status = "cloud-only"; state.lastAccessedAt = Date.now();
    this.store.setState(state); await this.store.save(); this.emit("nodeChanged", nodeId); return state;
  }
  async stageBytes(nodeId: string, bytes: Uint8Array): Promise<NodeState> {
    const node = await this.getNode(nodeId); if (node.kind !== "file") throw new Error("Cannot write a folder"); const state = this.stateFor(node);
    state.stagingPath = await this.storage.stageBytes(bytes, nodeId); state.baseRevision = state.remoteRevision || node.revision; state.status = "dirty"; state.error = undefined;
    this.store.setState(state); await this.store.save(); this.emit("nodeChanged", nodeId); return state;
  }
  async stageFile(nodeId: string, localPath: string): Promise<NodeState> {
    const node = await this.getNode(nodeId); const state = this.stateFor(node);
    state.stagingPath = await this.storage.stageFrom(localPath, nodeId); state.baseRevision = state.remoteRevision || node.revision; state.status = "dirty"; state.error = undefined;
    this.store.setState(state); await this.store.save(); this.emit("nodeChanged", nodeId); return state;
  }
  async beginWrite(nodeId: string): Promise<string> {
    if (this.scheduledCommits.has(nodeId) || this.activeCommits.has(nodeId)) throw new Error("A previous version is still uploading");
    const node = await this.getNode(nodeId); const current = this.stateFor(node);
    if (current.status === "conflict") throw new ConflictError("Resolve the existing conflict before editing again");
    if (current.stagingPath && ["dirty", "queued", "error"].includes(current.status) && await this.storage.exists(current.stagingPath)) {
      current.status = "dirty"; current.error = undefined; this.store.setState(current); await this.store.save(); return current.stagingPath;
    }
    const source = await this.materialize(nodeId); const state = await this.stageFile(nodeId, source); return state.stagingPath!;
  }
  async queueCommit(nodeId: string): Promise<NodeState> {
    const cachedNode = this.store.getNode(nodeId); if (!cachedNode) throw new Error(`Node not known: ${nodeId}`); const state = this.stateFor(cachedNode);
    if (!state.stagingPath) throw new Error("No staged changes");
    if (this.scheduledCommits.has(nodeId) || this.activeCommits.has(nodeId)) return state;
    state.status = "queued"; state.error = undefined; this.store.setState(state); await this.store.save(); this.emit("nodeChanged", nodeId);
    this.scheduledCommits.add(nodeId);
    setImmediate(() => { this.scheduledCommits.delete(nodeId); void this.commit(nodeId); });
    return state;
  }
  async commit(nodeId: string): Promise<NodeState> {
    const active = this.activeCommits.get(nodeId); if (active) return active;
    const operation = this.performCommit(nodeId).finally(() => this.activeCommits.delete(nodeId));
    this.activeCommits.set(nodeId, operation); return operation;
  }
  private async performCommit(nodeId: string): Promise<NodeState> {
    const cachedNode = this.store.getNode(nodeId); if (!cachedNode) throw new Error(`Node not known: ${nodeId}`); const state = this.stateFor(cachedNode);
    if (!state.stagingPath) throw new Error("No staged changes"); const expectedSize = await this.storage.size(state.stagingPath);
    state.status = "uploading"; this.store.setState(state); await this.store.save(); const transfer = this.transfers.start(nodeId, "upload", cachedNode.name, expectedSize);
    try {
      const remote = await this.provider.getNode(nodeId);
      if (state.baseRevision && remote.revision !== state.baseRevision) throw new ConflictError();
      const uploaded = await this.provider.upload({ parentId: cachedNode.parentId ?? "root", nodeId, name: cachedNode.name, sourcePath: state.stagingPath, expectedSize, expectedRevision: state.baseRevision, modifiedAt: Date.now(), onProgress: done => this.transfers.progress(transfer.id, done) });
      const cachePath = this.storage.cachePath(nodeId); await copyFile(state.stagingPath, cachePath); await this.storage.remove(state.stagingPath);
      state.stagingPath = undefined; state.cachePath = cachePath; state.remoteRevision = uploaded.revision; state.baseRevision = undefined; state.status = state.pinned ? "pinned" : "cached"; state.error = undefined;
      this.store.setNode(uploaded); this.store.setState(state); await this.store.save(); this.transfers.finish(transfer.id); this.emit("nodeChanged", nodeId); return state;
    } catch (e) {
      if (e instanceof ConflictError) { const preserved = await this.storage.preserveConflict(state.stagingPath!, nodeId, cachedNode.name); state.status = "conflict"; state.error = `Both versions preserved; local copy: ${preserved}`; }
      else if (e instanceof OfflineError) { state.status = "queued"; state.error = "Waiting for network"; }
      else { state.status = "error"; state.error = e instanceof Error ? e.message : String(e); }
      this.store.setState(state); await this.store.save(); this.transfers.fail(transfer.id, e); this.emit("nodeChanged", nodeId); return state;
    }
  }
  async syncQueued(): Promise<void> { for (const state of this.store.getStates()) if (state.status === "queued") await this.commit(state.nodeId); }
  async maintenanceCycle(maxCacheBytes: number): Promise<void> {
    await this.syncQueued();
    await this.processEvents();
    await this.enforceCacheLimit(maxCacheBytes);
  }
  async createFolder(parentId: string, name: string): Promise<DriveNode> { const node = await this.provider.createFolder(parentId, name); await this.remember(node); return node; }
  async createFile(parentId: string, name: string, bytes: Uint8Array): Promise<DriveNode> {
    const temporaryId = `new-${randomUUID()}`; const sourcePath = await this.storage.stageBytes(bytes, temporaryId);
    try { const node = await this.provider.upload({ parentId, name, sourcePath, expectedSize: bytes.byteLength, modifiedAt: Date.now() }); await this.remember(node); return node; }
    finally { await this.storage.remove(sourcePath); }
  }
  async rename(nodeId: string, name: string): Promise<DriveNode> { const node = await this.provider.rename(nodeId, name); await this.remember(node, { ...this.stateFor(node), remoteRevision: node.revision }); return node; }
  async move(nodeId: string, parentId: string): Promise<DriveNode> { const node = await this.provider.move(nodeId, parentId); await this.remember(node, { ...this.stateFor(node), remoteRevision: node.revision }); return node; }
  async trash(nodeId: string): Promise<void> { const state = this.store.getState(nodeId); if (state && UNSAFE_EVICTION.has(state.status)) throw new UnsafeEvictionError(state.status); await this.provider.trash(nodeId); this.store.deleteNode(nodeId); await this.store.save(); this.emit("nodeChanged", nodeId); }
  async processEvents(): Promise<void> {
    for await (const event of this.provider.getEvents(this.store.getLastEventId())) {
      if (event.type === "refresh") {
        const root=await this.provider.getRoot(); this.store.setNode(root);
        for (const node of await this.provider.listChildren(root.id)) this.store.setNode(node);
      } else if (event.type === "trashed") this.store.deleteNode(event.nodeId);
      else if (event.node) { const previous = this.store.getState(event.nodeId); this.store.setNode(event.node); if (previous) { if (previous.pinned && previous.remoteRevision !== event.node.revision && !["dirty", "queued", "uploading", "conflict"].includes(previous.status)) { await this.storage.remove(previous.cachePath); previous.cachePath = undefined; previous.status = "cloud-only"; } previous.remoteRevision = event.node.revision; this.store.setState(previous); } }
      this.store.setLastEventId(event.id); await this.store.save(); this.emit("nodeChanged", event.nodeId);
      const state = this.store.getState(event.nodeId); if (state?.pinned && state.status === "cloud-only") await this.pin(event.nodeId, true);
    }
  }
  async enforceCacheLimit(maxBytes: number): Promise<number> {
    const candidates = this.store.getStates().filter(s => s.status === "cached" && !s.pinned && s.cachePath).sort((a,b) => a.lastAccessedAt-b.lastAccessedAt);
    let total = 0; for (const s of this.store.getStates()) if (s.cachePath) { try { total += await this.storage.size(s.cachePath); } catch {} }
    for (const state of candidates) { if (total <= maxBytes) break; const size = await this.storage.size(state.cachePath!); await this.evict(state.nodeId); total -= size; }
    return total;
  }
}
