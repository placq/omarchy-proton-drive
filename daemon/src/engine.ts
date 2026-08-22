import { copyFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DriveProvider, RequestPriority } from "./provider.ts";
import { ConflictError, OfflineError, UnsafeEvictionError, UnsafeMutationError, type DriveNode, type NodeState, type Transfer } from "./domain.ts";
import { LocalStorage } from "./local-storage.ts";
import { StateStore } from "./state-store.ts";
import { TransferManager } from "./transfer-manager.ts";
import { clampedIntegerSetting } from "./settings.ts";

const UNSAFE_EVICTION = new Set(["dirty", "queued", "uploading", "conflict"]);
const LISTING_TTL_MS = clampedIntegerSetting("OMARCHY_DRIVE_LISTING_TTL_MS", 30_000, 1_000);
const PREFETCH_CONCURRENCY = clampedIntegerSetting("OMARCHY_DRIVE_PREFETCH_CONCURRENCY", 2, 1);

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result, "utf8") + Buffer.byteLength(character, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
}

function defaultConflictCopyName(name: string): string {
  const suffix = ` (local conflict ${new Date().toISOString().replaceAll(":", "-")})`;
  return `${truncateUtf8(name, 255 - Buffer.byteLength(suffix, "utf8"))}${suffix}`;
}

function replacementBackupName(name: string): string {
  const suffix = ` (replaced backup ${randomUUID().slice(0, 8)})`;
  return `${truncateUtf8(name, 255 - Buffer.byteLength(suffix, "utf8"))}${suffix}`;
}

export class DriveEngine extends EventEmitter {
  readonly transfers = new TransferManager();
  readonly provider: DriveProvider;
  readonly store: StateStore;
  readonly storage: LocalStorage;
  private readonly activeCommits = new Map<string, Promise<NodeState>>();
  private readonly scheduledCommits = new Set<string>();
  private readonly queuedTransfers = new Map<string, string>();
  private readonly uploadAborts = new Map<string, AbortController>();
  private readonly activeDownloads = new Map<string, Promise<string>>();
  private readonly activeListings = new Map<string, Promise<DriveNode[]>>();
  private activeRoot?: Promise<DriveNode>;
  private readonly prefetchQueued = new Set<string>();
  private readonly prefetchQueue: string[] = [];
  private prefetchActive = 0;
  private readonly prefetchLimit: number;
  constructor(provider: DriveProvider, store: StateStore, storage: LocalStorage) {
    super();
    this.provider = provider;
    this.store = store;
    this.storage = storage;
    this.prefetchLimit = clampedIntegerSetting("OMARCHY_DRIVE_PREFETCH_FOLDERS", provider.kind === "proton-cli" ? 0 : 12, 0);
  }

  async initialize(): Promise<void> {
    await Promise.all([this.store.load(), this.storage.initialize()]);
    this.provider.primeNodes?.(this.store.getNodes());
    let changed = false;
    for (const state of this.store.getStates()) {
      const stagingExists = await this.storage.exists(state.stagingPath); const cacheExists = await this.storage.exists(state.cachePath);
      if (state.status === "uploading") {
        state.status = stagingExists ? "queued" : "error";
        state.interruptedUpload = stagingExists || undefined;
        state.error = stagingExists ? "Recovered interrupted upload; waiting to retry" : "Interrupted upload has no staging file";
        this.store.setState(state); changed = true;
      } else if (["dirty", "queued", "conflict"].includes(state.status) && !stagingExists) {
        state.status = "error"; state.error = "Persistent staging file is missing"; this.store.setState(state); changed = true;
      } else if (["cached", "pinned"].includes(state.status) && !cacheExists) {
        state.status = "cloud-only"; state.cachePath = undefined; this.store.setState(state); changed = true;
      } else if (state.status === "downloading") {
        state.status = "error"; state.error = "Download was interrupted and can be retried"; this.store.setState(state); changed = true;
      }
      if (["cloud-only", "cached", "pinned"].includes(state.status) && state.stagingPath) {
        if (stagingExists) await this.storage.remove(state.stagingPath);
        state.stagingPath = undefined; this.store.setState(state); changed = true;
      }
    }
    if (changed) await this.store.save();
  }
  private stateFor(node: DriveNode): NodeState {
    return this.store.getState(node.id) ?? { nodeId: node.id, status: "cloud-only", pinned: false, remoteRevision: node.revision, lastAccessedAt: Date.now() };
  }
  private logWarn(event: string, error: unknown): void {
    console.error(JSON.stringify({ level: "warn", event, error: error instanceof Error ? error.message : String(error) }));
  }
  private async remember(node: DriveNode, state?: NodeState): Promise<void> {
    this.store.setNode(node); this.store.setState(state ?? this.stateFor(node)); await this.store.save(); this.emit("nodeChanged", node.id);
  }
  async root(): Promise<DriveNode> {
    const cached = this.store.getRoot();
    if (cached) { void this.refreshRoot("background").catch(error => this.logWarn("root_refresh_failed", error)); return cached; }
    return this.refreshRoot();
  }
  private async refreshRoot(priority: RequestPriority = "interactive"): Promise<DriveNode> {
    if (this.activeRoot) return this.activeRoot;
    const operation = (async () => { const root = await this.provider.getRoot(priority); await this.remember(root); return root; })().finally(() => { this.activeRoot = undefined; });
    this.activeRoot = operation; return operation;
  }
  async listChildren(parentId: string): Promise<DriveNode[]> {
    const cached = this.store.getChildren(parentId);
    const parent = this.store.getNode(parentId);
    const parentState = parent ? this.stateFor(parent) : undefined;
    const known = Boolean(parentState?.childrenKnown || cached.length);
    if (known) {
      if (parentState && !parentState.childrenKnown) {
        parentState.childrenKnown = true; this.store.setState(parentState); await this.store.save();
      }
      if (!parentState?.childrenRefreshedAt || Date.now() - parentState.childrenRefreshedAt >= LISTING_TTL_MS) {
        void this.refreshChildren(parentId, "background").catch(error => this.logWarn("children_refresh_failed", error));
      }
      this.schedulePrefetch(cached);
      return cached;
    }
    const nodes = await this.refreshChildren(parentId);
    this.schedulePrefetch(nodes);
    return nodes;
  }
  async lookupChild(parentId: string, name: string): Promise<DriveNode> {
    const cached = this.store.findChild(parentId, name);
    if (cached) {
      const parent = this.store.getNode(parentId); const state = parent ? this.stateFor(parent) : undefined;
      if (!state?.childrenRefreshedAt || Date.now() - state.childrenRefreshedAt >= LISTING_TTL_MS) void this.refreshChildren(parentId, "background").catch(error => this.logWarn("children_refresh_failed", error));
      return cached;
    }
    const child = (await this.refreshChildren(parentId)).find(node => node.name === name);
    if (!child) throw new Error(`Node not found: ${name}`);
    return child;
  }
  private async refreshChildren(parentId: string, priority: RequestPriority = "interactive"): Promise<DriveNode[]> {
    const active = this.activeListings.get(parentId); if (active) return active;
    const operation = this.performRefreshChildren(parentId, priority).finally(() => this.activeListings.delete(parentId));
    this.activeListings.set(parentId, operation); return operation;
  }
  private async performRefreshChildren(parentId: string, priority: RequestPriority): Promise<DriveNode[]> {
    try {
      const nodes = await this.provider.listChildren(parentId, priority);
      const seen = new Set(nodes.map(node => node.id));
      for (const node of nodes) { this.store.setNode(node); const state = this.stateFor(node); state.remoteRevision = node.revision; state.remoteDeleted = undefined; this.store.setState(state); }
      for (const cached of this.store.getChildren(parentId).filter(node => !seen.has(node.id))) {
        await this.reconcileRemoteDeletion(cached.id);
      }
      const parent = this.store.getNode(parentId);
      if (parent) {
        const state = this.stateFor(parent); state.childrenKnown = true; state.childrenRefreshedAt = Date.now(); this.store.setState(state);
      }
      await this.store.save(); this.emit("nodeChanged", parentId); return this.store.getChildren(parentId);
    } catch (e) {
      if (e instanceof OfflineError) return this.store.getNodes().filter(n => n.parentId === parentId);
      throw e;
    }
  }
  private schedulePrefetch(nodes: DriveNode[]): void {
    for (const folder of nodes.filter(node => node.kind === "folder").slice(0, this.prefetchLimit)) {
      const state = this.store.getState(folder.id);
      const hasPersistedChildren = this.store.getChildren(folder.id).length > 0;
      if (state?.childrenKnown || hasPersistedChildren || this.activeListings.has(folder.id) || this.prefetchQueued.has(folder.id)) continue;
      this.prefetchQueued.add(folder.id); this.prefetchQueue.push(folder.id);
    }
    this.drainPrefetch();
  }
  private drainPrefetch(): void {
    while (this.prefetchActive < PREFETCH_CONCURRENCY && this.prefetchQueue.length) {
      const folderId = this.prefetchQueue.shift()!; this.prefetchQueued.delete(folderId); this.prefetchActive += 1;
      void this.refreshChildren(folderId, "background").catch(error => this.logWarn("prefetch_failed", error)).finally(() => { this.prefetchActive -= 1; this.drainPrefetch(); });
    }
  }
  async getNode(nodeId: string): Promise<DriveNode> {
    try { const node = await this.provider.getNode(nodeId); this.store.setNode(node); await this.store.save(); return node; }
    catch (e) { const cached = this.store.getNode(nodeId); if (e instanceof OfflineError && cached) return cached; throw e; }
  }
  private freshListedNode(nodeId: string): DriveNode | undefined {
    const node = this.store.getNode(nodeId);
    if (!node?.parentId) return undefined;
    const parentState = this.store.getState(node.parentId);
    if (!parentState?.childrenRefreshedAt || Date.now() - parentState.childrenRefreshedAt >= LISTING_TTL_MS) return undefined;
    return node;
  }
  getState(nodeId: string): NodeState | undefined { return this.store.getState(nodeId); }
  async materialize(nodeId: string): Promise<string> {
    const active = this.activeDownloads.get(nodeId); if (active) return active;
    const operation = this.performMaterialize(nodeId).finally(() => this.activeDownloads.delete(nodeId));
    this.activeDownloads.set(nodeId, operation); return operation;
  }
  private async performMaterialize(nodeId: string): Promise<string> {
    const cachedNode = this.store.getNode(nodeId); const cachedState = cachedNode ? this.stateFor(cachedNode) : undefined;
    if (cachedState?.cachePath && cachedState.remoteRevision === cachedNode!.revision && ["cached", "pinned"].includes(cachedState.status) && await this.storage.exists(cachedState.cachePath)) {
      cachedState.lastAccessedAt = Date.now(); this.store.setState(cachedState); void this.store.save(); return cachedState.cachePath;
    }
    if (cachedState?.cachePath && ["queued", "uploading", "error"].includes(cachedState.status) && await this.storage.exists(cachedState.cachePath)) return cachedState.cachePath;
    if (cachedState?.stagingPath && ["dirty", "queued", "conflict"].includes(cachedState.status) && await this.storage.exists(cachedState.stagingPath)) return cachedState.stagingPath;
    const node = this.freshListedNode(nodeId) ?? await this.getNode(nodeId); if (node.kind !== "file") throw new Error("Cannot open a folder as a file");
    const state = this.stateFor(node);
    state.status = "downloading"; this.store.setState(state); await this.store.save();
    const transfer = this.transfers.start(node.id, "download", node.name, this.provider.progressSupported === false ? 0 : node.size);
    try {
      const path = this.storage.cachePath(node.id); const temporary = this.storage.downloadPath(node.id);
      await this.storage.remove(temporary);
      const result = await this.provider.downloadToPath(node.id, temporary, (done) => this.transfers.progress(transfer.id, done), node);
      await this.storage.finalizeDownload(temporary, path);
      state.cachePath = path; state.remoteRevision = result.revision; state.status = state.pinned ? "pinned" : "cached"; state.lastAccessedAt = Date.now();
      this.store.setState(state); await this.store.save(); this.transfers.finish(transfer.id); this.emit("nodeChanged", node.id); return path;
    } catch (e) { state.status = "error"; state.error = e instanceof Error ? e.message : String(e); this.store.setState(state); await this.store.save(); this.transfers.fail(transfer.id, e); throw e; }
  }
  async pin(nodeId: string, pinned: boolean): Promise<NodeState> {
    const node = this.store.getNode(nodeId) ?? await this.getNode(nodeId); const state = this.stateFor(node); state.pinned = pinned; this.store.setState(state); await this.store.save();
    if (node.kind === "folder") {
      for (const child of await this.listChildren(node.id)) await this.pin(child.id, pinned);
      state.status = pinned ? "pinned" : "cached";
      this.store.setState(state); await this.store.save(); this.emit("nodeChanged", nodeId); return state;
    }
    if (pinned && node.kind === "file") await this.materialize(nodeId);
    const updated = this.stateFor(node); if (pinned && updated.status === "cached") updated.status = "pinned"; if (!pinned && updated.status === "pinned") updated.status = "cached";
    this.store.setState(updated); await this.store.save(); this.emit("nodeChanged", nodeId); return updated;
  }
  async evict(nodeId: string): Promise<NodeState> {
    const node = this.store.getNode(nodeId) ?? await this.getNode(nodeId); const state = this.stateFor(node);
    if (UNSAFE_EVICTION.has(state.status)) throw new UnsafeEvictionError(state.status);
    if (state.stagingPath && await this.storage.exists(state.stagingPath)) throw new UnsafeEvictionError(state.status);
    await this.storage.remove(state.cachePath); state.cachePath = undefined; state.pinned = false; state.status = "cloud-only"; state.lastAccessedAt = Date.now();
    this.store.setState(state); await this.store.save(); this.emit("nodeChanged", nodeId); return state;
  }
  async stageBytes(nodeId: string, bytes: Uint8Array): Promise<NodeState> {
    const node = this.store.getNode(nodeId) ?? await this.getNode(nodeId); if (node.kind !== "file") throw new Error("Cannot write a folder"); const state = this.stateFor(node);
    state.stagingPath = await this.storage.stageBytes(bytes, nodeId); state.baseRevision = state.remoteRevision || node.revision; state.status = "dirty"; state.error = undefined; state.interruptedUpload = undefined;
    this.store.setState(state); await this.store.save(); this.emit("nodeChanged", nodeId); return state;
  }
  async stageFile(nodeId: string, localPath: string): Promise<NodeState> {
    const node = this.store.getNode(nodeId) ?? await this.getNode(nodeId); if (node.kind !== "file") throw new Error("Cannot write a folder"); const state = this.stateFor(node);
    state.stagingPath = await this.storage.stageFrom(localPath, nodeId); state.baseRevision = state.remoteRevision || node.revision; state.status = "dirty"; state.error = undefined; state.interruptedUpload = undefined;
    this.store.setState(state); await this.store.save(); this.emit("nodeChanged", nodeId); return state;
  }
  async beginWrite(nodeId: string): Promise<string> {
    if (this.scheduledCommits.has(nodeId) || this.activeCommits.has(nodeId)) throw new Error("A previous version is still uploading");
    const node = this.store.getNode(nodeId) ?? await this.getNode(nodeId); const current = this.stateFor(node);
    if (current.status === "conflict") throw new ConflictError("Resolve the existing conflict before editing again");
    if (current.stagingPath && ["dirty", "queued", "error"].includes(current.status) && await this.storage.exists(current.stagingPath)) {
      current.status = "dirty"; current.error = undefined; current.interruptedUpload = undefined; this.store.setState(current); await this.store.save(); return current.stagingPath;
    }
    const source = await this.materialize(nodeId); current.stagingPath = await this.storage.stageFrom(source, nodeId);
    current.baseRevision = current.remoteRevision || node.revision; current.status = "dirty"; current.error = undefined; current.interruptedUpload = undefined;
    this.store.setState(current); await this.store.save(); this.emit("nodeChanged", nodeId); return current.stagingPath;
  }
  async queueCommit(nodeId: string): Promise<NodeState> {
    const cachedNode = this.store.getNode(nodeId); if (!cachedNode) throw new Error(`Node not known: ${nodeId}`); const state = this.stateFor(cachedNode);
    if (!state.stagingPath) throw new Error("No staged changes");
    if (this.scheduledCommits.has(nodeId) || this.activeCommits.has(nodeId)) return state;
    const cachePath = this.storage.cachePath(nodeId); await copyFile(state.stagingPath, cachePath); state.cachePath = cachePath;
    cachedNode.size = await this.storage.size(state.stagingPath); cachedNode.modifiedAt = Date.now(); this.store.setNode(cachedNode);
    state.status = "queued"; state.error = undefined; this.store.setState(state); await this.store.save(); this.emit("nodeChanged", nodeId);
    const queuedTransfer = this.transfers.start(nodeId, "upload", cachedNode.name, this.provider.progressSupported === false ? 0 : cachedNode.size, "queued");
    this.queuedTransfers.set(nodeId, queuedTransfer.id);
    this.scheduledCommits.add(nodeId);
    setImmediate(() => {
      this.scheduledCommits.delete(nodeId);
      void this.commit(nodeId).catch(error => this.logWarn("queued_commit_failed", error));
    });
    return state;
  }
  async commit(nodeId: string): Promise<NodeState> {
    const active = this.activeCommits.get(nodeId); if (active) return active;
    const operation = this.performCommit(nodeId).finally(() => this.activeCommits.delete(nodeId));
    this.activeCommits.set(nodeId, operation); return operation;
  }
  private async finalizeCommittedUpload(node: DriveNode, state: NodeState, cachePath: string, transfer: Transfer): Promise<NodeState> {
    const stagingPath = state.stagingPath!;
    state.cachePath = cachePath; state.remoteRevision = node.revision; state.baseRevision = undefined;
    state.interruptedUpload = undefined; state.status = state.pinned ? "pinned" : "cached"; state.error = undefined;
    // Persist the committed remote revision while staging still exists. A
    // crash before the next phase therefore retains both recovery facts.
    this.store.setNode(node); this.store.setState(state); await this.store.save();
    try { await this.storage.remove(stagingPath); }
    catch (error) {
      this.logWarn("committed_staging_cleanup_failed", error);
      this.transfers.finish(transfer.id); this.emit("nodeChanged", node.id); return state;
    }
    state.stagingPath = undefined; this.store.setState(state);
    try { await this.store.save(); }
    catch (error) { this.logWarn("committed_staging_state_cleanup_failed", error); }
    this.transfers.finish(transfer.id); this.emit("nodeChanged", node.id); return state;
  }
  private async performCommit(nodeId: string): Promise<NodeState> {
    const cachedNode = this.store.getNode(nodeId); if (!cachedNode) throw new Error(`Node not known: ${nodeId}`); const state = this.stateFor(cachedNode);
    if (!state.stagingPath) throw new Error("No staged changes");
    const interruptedUpload = state.interruptedUpload === true;
    const expectedBaseRevision = state.baseRevision;
    const wasQueued = state.status === "queued";
    const expectedSize = await this.storage.size(state.stagingPath);
    const cachePath = this.storage.cachePath(nodeId); await copyFile(state.stagingPath, cachePath); state.cachePath = cachePath;
    // A cancel that raced the staging copy reverts to a dirty state; keep the
    // staged bytes editable and re-uploadable instead of uploading anyway.
    if (wasQueued && state.status === "dirty") return state;
    state.status = "uploading"; this.store.setState(state); await this.store.save();
    let transfer: Transfer;
    const queuedId = this.queuedTransfers.get(nodeId);
    if (queuedId) {
      const queued = this.transfers.list().find(candidate => candidate.id === queuedId);
      if (queued && queued.state === "queued") {
        this.transfers.begin(queued.id); transfer = queued;
      } else if (queued && queued.state === "cancelled") {
        this.queuedTransfers.delete(nodeId);
        state.status = "dirty"; state.error = undefined; this.store.setState(state); await this.store.save(); return state;
      } else {
        return state;
      }
    } else {
      transfer = this.transfers.start(nodeId, "upload", cachedNode.name, this.provider.progressSupported === false ? 0 : expectedSize);
    }
    const abort = new AbortController(); this.uploadAborts.set(transfer.id, abort);
    let committedRemote: DriveNode | undefined;
    try {
      const remote = await this.provider.getNode(nodeId);
      if (state.baseRevision && remote.revision !== state.baseRevision) {
        let alreadyCommitted = false;
        if (interruptedUpload && remote.size === expectedSize) {
          const recoveredDownload = `${this.storage.downloadPath(nodeId)}.${randomUUID()}.recovery`;
          try {
            await this.provider.downloadToPath(nodeId, recoveredDownload, undefined, remote);
            alreadyCommitted = await this.storage.sameBytes(state.stagingPath, recoveredDownload);
          } finally { await this.storage.remove(recoveredDownload); }
        }
        if (!alreadyCommitted) throw new ConflictError();
        committedRemote = remote;
        return await this.finalizeCommittedUpload(remote, state, cachePath, transfer);
      }
      const uploaded = await this.provider.upload({ parentId: cachedNode.parentId ?? "root", nodeId, name: cachedNode.name, sourcePath: state.stagingPath, expectedSize, expectedRevision: state.baseRevision, knownRemote: remote, modifiedAt: Date.now(), onProgress: done => this.transfers.progress(transfer.id, done), signal: abort.signal });
      committedRemote = uploaded;
      return await this.finalizeCommittedUpload(uploaded, state, cachePath, transfer);
    } catch (e) {
      if (committedRemote) {
        state.status = "queued"; state.interruptedUpload = true; state.baseRevision = expectedBaseRevision;
        state.remoteRevision = committedRemote.revision; state.error = "Remote upload completed; local finalisation will be verified and retried";
        this.store.setNode(committedRemote); this.store.setState(state);
        try { await this.store.save(); }
        catch (saveError) { this.logWarn("committed_upload_recovery_state_failed", saveError); }
        this.transfers.fail(transfer.id, e); this.emit("nodeChanged", nodeId); return state;
      }
      if (abort.signal.aborted) {
        state.status = "dirty"; state.error = "Upload cancelled"; state.cachePath = cachePath;
        this.store.setState(state); await this.store.save(); this.transfers.cancel(transfer.id); this.emit("nodeChanged", nodeId); return state;
      }
      if (e instanceof ConflictError) { const preserved = await this.storage.preserveConflict(state.stagingPath!, nodeId, cachedNode.name); state.status = "conflict"; state.interruptedUpload = undefined; state.error = `Both versions preserved; local copy: ${preserved}`; }
      else if (e instanceof OfflineError) { state.status = "queued"; state.error = "Waiting for network"; }
      else { state.status = "error"; state.error = e instanceof Error ? e.message : String(e); }
      this.store.setState(state); await this.store.save(); this.transfers.fail(transfer.id, e); this.emit("nodeChanged", nodeId); return state;
    } finally {
      this.uploadAborts.delete(transfer.id); this.queuedTransfers.delete(nodeId);
    }
  }
  async cancelQueuedUpload(transferId: string): Promise<NodeState> {
    const transfer = this.transfers.list().find(candidate => candidate.id === transferId);
    if (!transfer) throw new Error(`Unknown transfer: ${transferId}`);
    if (transfer.direction !== "upload") throw new Error("Only upload transfers can be cancelled");
    const node = this.store.getNode(transfer.nodeId); if (!node) throw new Error(`Node not known: ${transfer.nodeId}`);
    const state = this.stateFor(node);
    if (transfer.state === "queued") {
      if (state.status !== "queued") throw new Error("Upload is already running or finished");
      // The queued commit is still preparing staging; mark the transfer
      // cancelled and let the pending commit flip the node back to dirty so
      // the staged bytes stay editable and re-uploadable.
      this.transfers.cancel(transferId); this.emit("nodeChanged", transfer.nodeId); return state;
    }
    if (transfer.state === "running") {
      const abort = this.uploadAborts.get(transferId);
      if (!abort) throw new Error("Upload is already finishing");
      abort.abort(); return state;
    }
    throw new Error("Upload is already finished");
  }
  async syncQueued(): Promise<void> { for (const state of this.store.getStates()) if (state.status === "queued") await this.commit(state.nodeId); }
  async retry(nodeId: string): Promise<NodeState> {
    const node = this.store.getNode(nodeId) ?? await this.getNode(nodeId);
    const state = this.stateFor(node);
    if (state.stagingPath && await this.storage.exists(state.stagingPath)) return this.commit(nodeId);
    if (state.status === "error" && node.kind === "file") {
      await this.materialize(nodeId);
      return this.stateFor(node);
    }
    throw new Error("Node has no failed or queued operation to retry");
  }
  async maintenanceCycle(maxCacheBytes: number): Promise<void> {
    await this.syncQueued();
    await this.processEvents();
    await this.enforceCacheLimit(maxCacheBytes);
  }
  async createFolder(parentId: string, name: string): Promise<DriveNode> { const node = await this.provider.createFolder(parentId, name); await this.remember(node); return node; }
  async createFile(parentId: string, name: string, bytes: Uint8Array): Promise<DriveNode> {
    const temporaryId = `new-${randomUUID()}`; const sourcePath = await this.storage.stageBytes(bytes, temporaryId);
    try {
      const node = await this.provider.upload({ parentId, name, sourcePath, expectedSize: bytes.byteLength, modifiedAt: Date.now() });
      const cachePath = this.storage.cachePath(node.id); await copyFile(sourcePath, cachePath);
      await this.remember(node, { ...this.stateFor(node), status: "cached", cachePath, remoteRevision: node.revision, lastAccessedAt: Date.now() });
      return node;
    }
    finally { await this.storage.remove(sourcePath); }
  }
  private treeNodeIds(nodeId: string): string[] {
    const ids = [nodeId]; const seen = new Set(ids);
    for (let index = 0; index < ids.length; index += 1) {
      for (const child of this.store.getChildren(ids[index]!)) {
        if (!seen.has(child.id)) { seen.add(child.id); ids.push(child.id); }
      }
    }
    return ids;
  }
  private async reconcileRemoteDeletion(nodeId: string): Promise<void> {
    const ids = this.treeNodeIds(nodeId);
    const recoverable = new Map<string, { state: NodeState; stagingExists: boolean }>();
    let retainTree = false;
    for (const id of ids) {
      const state = this.store.getState(id); if (!state) continue;
      let stagingExists = await this.storage.exists(state.stagingPath);
      if (!stagingExists && UNSAFE_EVICTION.has(state.status) && state.cachePath && await this.storage.exists(state.cachePath)) {
        state.stagingPath = await this.storage.stageFrom(state.cachePath, id);
        stagingExists = true;
      }
      if (stagingExists) retainTree = true;
      recoverable.set(id, { state, stagingExists });
    }
    if (retainTree) {
      for (const id of ids) {
        const entry = recoverable.get(id);
        if (!entry) continue;
        entry.state.remoteDeleted = true;
        if (entry.stagingExists) {
          entry.state.status = "conflict";
          entry.state.error = "Remote file was deleted; local changes remain preserved in persistent staging";
        }
        this.store.setState(entry.state); this.emit("nodeChanged", id);
      }
      return;
    }
    for (const id of ids.reverse()) {
      const state = this.store.getState(id);
      await this.storage.remove(state?.cachePath);
      this.store.deleteNode(id); this.emit("nodeChanged", id);
    }
  }
  private async assertTreeSafe(nodeId: string, operation: string): Promise<void> {
    for (const id of this.treeNodeIds(nodeId)) {
      const state = this.store.getState(id);
      if (!state) continue;
      if (UNSAFE_EVICTION.has(state.status) || await this.storage.exists(state.stagingPath)) throw new UnsafeMutationError(operation, state.status);
    }
  }
  async rename(nodeId: string, name: string): Promise<DriveNode> {
    await this.assertTreeSafe(nodeId, "rename");
    const known = this.store.getNode(nodeId);
    const node = await this.provider.rename(nodeId, name, known); await this.remember(node, { ...this.stateFor(node), remoteRevision: node.revision }); return node;
  }
  async move(nodeId: string, parentId: string): Promise<DriveNode> {
    if (this.treeNodeIds(nodeId).includes(parentId)) throw new Error("Cannot move a folder into itself or its descendant");
    await this.assertTreeSafe(nodeId, "move");
    const known = this.store.getNode(nodeId);
    const node = await this.provider.move(nodeId, parentId, known); await this.remember(node, { ...this.stateFor(node), remoteRevision: node.revision }); return node;
  }
  async replace(sourceId: string, destinationId: string): Promise<DriveNode> {
    if (sourceId === destinationId) return this.store.getNode(sourceId) ?? await this.getNode(sourceId);
    await this.assertTreeSafe(sourceId, "replace"); await this.assertTreeSafe(destinationId, "replace");
    const source = this.store.getNode(sourceId) ?? await this.getNode(sourceId);
    const destination = this.store.getNode(destinationId) ?? await this.getNode(destinationId);
    if (source.kind !== "file" || destination.kind !== "file") throw new Error("Only files can replace existing files");
    if (!destination.parentId) throw new Error("The Proton Drive root cannot be replaced");
    const sourceState = this.stateFor(source); const destinationState = this.stateFor(destination);
    const backupName = replacementBackupName(destination.name);
    await this.provider.rename(destination.id, backupName, destination);
    let replaced = source;
    let sourceMoved = false;
    try {
      if (replaced.parentId !== destination.parentId) {
        replaced = await this.provider.move(replaced.id, destination.parentId, replaced);
        sourceMoved = true;
      }
      if (replaced.name !== destination.name) replaced = await this.provider.rename(replaced.id, destination.name, replaced);
    } catch (error) {
      if (sourceMoved && source.parentId) {
        try { replaced = await this.provider.move(replaced.id, source.parentId, replaced); }
        catch (rollbackError) { this.logWarn("replace_source_rollback_failed", rollbackError); }
      }
      try { await this.provider.rename(destination.id, destination.name, destination); }
      catch (rollbackError) { this.logWarn("replace_rollback_failed", rollbackError); }
      throw error;
    }
    sourceState.pinned ||= destinationState.pinned;
    sourceState.status = sourceState.pinned && sourceState.cachePath ? "pinned" : sourceState.status;
    sourceState.remoteRevision = replaced.revision; sourceState.remoteDeleted = undefined;
    this.store.setNode(replaced); this.store.setState(sourceState); this.store.deleteNode(destination.id); await this.store.save();
    await this.storage.remove(destinationState.cachePath);
    this.emit("nodeChanged", destination.id); this.emit("nodeChanged", replaced.id);
    try { await this.provider.trash(destination.id); }
    catch (error) { this.logWarn("replace_backup_cleanup_failed", error); }
    return replaced;
  }
  async trash(nodeId: string): Promise<void> {
    await this.assertTreeSafe(nodeId, "trash");
    const node = this.store.getNode(nodeId) ?? await this.getNode(nodeId);
    const removedIds = this.treeNodeIds(nodeId);
    const transfer = this.transfers.start(nodeId, "trash", node.name, 0);
    try {
      await this.provider.trash(nodeId);
      for (const id of removedIds) this.store.deleteNode(id);
      await this.store.save();
      for (const id of removedIds) this.emit("nodeChanged", id);
      this.transfers.finish(transfer.id);
    } catch (error) {
      this.transfers.fail(transfer.id, error);
      throw error;
    }
  }
  async resolveConflict(nodeId: string, resolution: "keep-local" | "keep-remote" | "save-both", copyName?: string): Promise<NodeState> {
    const node = this.store.getNode(nodeId) ?? await this.getNode(nodeId);
    const state = this.stateFor(node);
    if (state.status !== "conflict" || !state.stagingPath || !(await this.storage.exists(state.stagingPath))) throw new Error("Node has no resolvable conflict");
    if (state.remoteDeleted) return this.resolveRemoteDeletedConflict(node, state, resolution, copyName);
    if (resolution === "keep-local") {
      const remote = await this.provider.getNode(nodeId);
      state.baseRevision = remote.revision; state.remoteRevision = remote.revision; state.status = "queued"; state.error = undefined;
      this.store.setState(state); await this.store.save(); return this.commit(nodeId);
    }
    if (resolution === "save-both") {
      const name = copyName?.trim() || defaultConflictCopyName(node.name);
      const size = await this.storage.size(state.stagingPath);
      const created = await this.provider.upload({ parentId: node.parentId ?? "root", name, sourcePath: state.stagingPath, expectedSize: size, modifiedAt: Date.now() });
      await this.remember(created);
    }
    const stagingPath = state.stagingPath; const cachePath = state.cachePath;
    state.stagingPath = undefined; state.cachePath = undefined; state.baseRevision = undefined; state.status = "cloud-only"; state.error = undefined;
    const remote = await this.provider.getNode(nodeId); state.remoteRevision = remote.revision; this.store.setNode(remote); this.store.setState(state); await this.store.save(); this.emit("nodeChanged", nodeId);
    // Persist the stable state before deleting local files. A crash can leave
    // harmless orphans, but cannot leave state pointing at deleted data.
    await this.storage.remove(stagingPath); await this.storage.remove(cachePath);
    if (state.pinned) return this.pin(nodeId, true);
    return state;
  }
  private async restoreRemoteDeletedFolder(folderId: string): Promise<string> {
    const folder = this.store.getNode(folderId);
    const state = this.store.getState(folderId);
    if (!folder || !state?.remoteDeleted) return folderId;
    if (folder.kind !== "folder" || !folder.parentId) throw new Error("Cannot restore an invalid deleted parent folder");
    const parentId = await this.restoreRemoteDeletedFolder(folder.parentId);
    const created = await this.provider.createFolder(parentId, folder.name);
    const children = this.store.getChildren(folder.id);
    const restoredState: NodeState = {
      ...state,
      nodeId: created.id,
      status: state.pinned ? "pinned" : "cloud-only",
      remoteRevision: created.revision,
      remoteDeleted: undefined,
      baseRevision: undefined,
      cachePath: undefined,
      stagingPath: undefined,
      error: undefined,
      childrenRefreshedAt: undefined,
    };
    this.store.setNode(created); this.store.setState(restoredState);
    for (const child of children) this.store.setNode({ ...child, parentId: created.id });
    this.store.deleteNode(folder.id); await this.store.save();
    this.emit("nodeChanged", folder.id); this.emit("nodeChanged", created.id);
    return created.id;
  }
  private remoteDeletedTreeRoot(node: DriveNode): string {
    let rootId = node.id; let parentId = node.parentId;
    while (parentId && this.store.getState(parentId)?.remoteDeleted) {
      rootId = parentId;
      parentId = this.store.getNode(parentId)?.parentId ?? null;
    }
    return rootId;
  }
  private async resolveRemoteDeletedConflict(node: DriveNode, state: NodeState, resolution: "keep-local" | "keep-remote" | "save-both", copyName?: string): Promise<NodeState> {
    const stagingPath = state.stagingPath!; const oldCachePath = state.cachePath;
    if (resolution !== "keep-remote") {
      const parentId = node.parentId ? await this.restoreRemoteDeletedFolder(node.parentId) : "root";
      const size = await this.storage.size(stagingPath);
      const name = resolution === "save-both" ? copyName?.trim() || defaultConflictCopyName(node.name) : node.name;
      const created = await this.provider.upload({ parentId, name, sourcePath: stagingPath, expectedSize: size, modifiedAt: Date.now() });
      if (resolution === "save-both") await this.remember(created);
      else {
      const newCachePath = this.storage.cachePath(created.id);
      let cachePath: string | undefined;
      try { await copyFile(stagingPath, newCachePath); cachePath = newCachePath; }
      catch (error) { this.logWarn("restored_file_cache_failed", error); }
      const restored: NodeState = {
        nodeId: created.id, status: cachePath ? (state.pinned ? "pinned" : "cached") : "cloud-only",
        pinned: state.pinned, remoteRevision: created.revision, cachePath, lastAccessedAt: Date.now(),
      };
      this.store.setNode(created); this.store.setState(restored); this.store.deleteNode(node.id); await this.store.save();
      this.emit("nodeChanged", node.id); this.emit("nodeChanged", created.id);
      await this.storage.remove(stagingPath); if (oldCachePath !== cachePath) await this.storage.remove(oldCachePath);
      return restored;
      }
    }
    const deletedRoot = this.remoteDeletedTreeRoot(node);
    const resolved: NodeState = { ...state, status: "cloud-only", stagingPath: undefined, cachePath: undefined, baseRevision: undefined, remoteDeleted: undefined, error: undefined };
    this.store.deleteNode(node.id);
    if (deletedRoot !== node.id && this.store.getNode(deletedRoot)) await this.reconcileRemoteDeletion(deletedRoot);
    await this.store.save(); this.emit("nodeChanged", node.id);
    await this.storage.remove(stagingPath); await this.storage.remove(oldCachePath);
    return resolved;
  }
  conflicts(): Array<{ nodeId: string; name: string; error?: string }> {
    return this.store.getStates()
      .filter(state => state.status === "conflict")
      .map(state => {
        const node = this.store.getNode(state.nodeId);
        return { nodeId: state.nodeId, name: node?.name ?? state.nodeId, error: state.error };
      });
  }
  private async refreshKnownFolders(rootId: string): Promise<void> {
    const knownNodes = this.store.getNodes();
    const folderIds = new Set<string>([rootId]);
    for (const node of knownNodes) {
      const state = this.store.getState(node.id);
      if (!state?.pinned || state.remoteDeleted) continue;
      if (node.kind === "folder") folderIds.add(node.id);
      if (node.parentId) folderIds.add(node.parentId);
    }
    for (const parentId of folderIds) {
      if (parentId !== rootId && !this.store.getNode(parentId)) continue;
      if (this.store.getState(parentId)?.remoteDeleted) continue;
      const seenChildren = new Set<string>();
      for (const node of await this.provider.listChildren(parentId, "background")) {
        seenChildren.add(node.id);
        const previous = this.store.getState(node.id);
        if (previous && previous.remoteRevision !== node.revision && !UNSAFE_EVICTION.has(previous.status)) {
          await this.storage.remove(previous.cachePath);
          previous.cachePath = undefined;
          previous.status = "cloud-only";
        }
        this.store.setNode(node);
        const state = this.stateFor(node); state.remoteDeleted = undefined;
        state.remoteRevision = node.revision;
        this.store.setState(state);
      }
      for (const node of this.store.getChildren(parentId)) {
        if (seenChildren.has(node.id)) continue;
        await this.reconcileRemoteDeletion(node.id);
      }
    }
    await this.store.save();
  }
  async processEvents(): Promise<void> {
    for await (const event of this.provider.getEvents(this.store.getLastEventId())) {
      if (event.type === "refresh") {
        const root = await this.provider.getRoot("background");
        this.store.setNode(root);
        await this.refreshKnownFolders(root.id);
      } else if (event.type === "trashed") await this.reconcileRemoteDeletion(event.nodeId);
      else if (event.node) { const previous = this.store.getState(event.nodeId); this.store.setNode(event.node); if (previous) { if (previous.pinned && previous.remoteRevision !== event.node.revision && !["dirty", "queued", "uploading", "conflict"].includes(previous.status)) { await this.storage.remove(previous.cachePath); previous.cachePath = undefined; previous.status = "cloud-only"; } previous.remoteRevision = event.node.revision; previous.remoteDeleted = undefined; this.store.setState(previous); } }
      // Proton emits `tree_remove` with eventId="none". It is a refresh
      // marker, not a resumable cursor; persisting it would make the next
      // event request restart from an invalid cursor.
      if (event.id !== "none") this.store.setLastEventId(event.id);
      await this.store.save(); this.emit("nodeChanged", event.nodeId);
      const state = this.store.getState(event.nodeId); if (state?.pinned && state.status === "cloud-only") await this.pin(event.nodeId, true);
    }
    for (const state of this.store.getStates()) {
      if (state.pinned && state.status === "cloud-only" && this.store.getNode(state.nodeId)?.kind === "file") await this.pin(state.nodeId, true);
    }
  }
  async enforceCacheLimit(maxBytes: number): Promise<number> {
    const candidates = this.store.getStates().filter(s => s.status === "cached" && !s.pinned && s.cachePath).sort((a,b) => a.lastAccessedAt-b.lastAccessedAt);
    let total = 0; for (const s of this.store.getStates()) if (s.cachePath) { try { total += await this.storage.size(s.cachePath); } catch {} }
    for (const state of candidates) { if (total <= maxBytes) break; const size = await this.storage.size(state.cachePath!); await this.evict(state.nodeId); total -= size; }
    return total;
  }
  async cacheUsage(): Promise<number> {
    let total = 0;
    for (const state of this.store.getStates()) if (state.cachePath) {
      try { total += await this.storage.size(state.cachePath); } catch {}
    }
    return total;
  }
  async clearDisposableCache(): Promise<{ freedBytes: number; cacheBytes: number; retainedPinnedBytes: number; retainedPinnedFiles: number }> {
    const before = await this.cacheUsage();
    const cacheBytes = await this.enforceCacheLimit(0);
    let retainedPinnedBytes = 0; let retainedPinnedFiles = 0;
    for (const state of this.store.getStates()) {
      if (!state.pinned || !state.cachePath) continue;
      try { retainedPinnedBytes += await this.storage.size(state.cachePath); retainedPinnedFiles += 1; } catch {}
    }
    return { freedBytes: Math.max(0, before - cacheBytes), cacheBytes, retainedPinnedBytes, retainedPinnedFiles };
  }
  async clearPinnedCache(): Promise<{ freedBytes: number; cacheBytes: number; clearedPinnedFiles: number; retainedUnsafeBytes: number; retainedUnsafeFiles: number }> {
    let freedBytes = 0; let clearedPinnedFiles = 0; let retainedUnsafeBytes = 0; let retainedUnsafeFiles = 0;
    const changed: string[] = [];
    for (const state of this.store.getStates()) {
      if (!state.pinned) continue;
      const node = this.store.getNode(state.nodeId);
      const hasUnsafeLocalChanges = UNSAFE_EVICTION.has(state.status) || await this.storage.exists(state.stagingPath);
      if (hasUnsafeLocalChanges) {
        if (node?.kind === "file") retainedUnsafeFiles += 1;
        if (state.cachePath) { try { retainedUnsafeBytes += await this.storage.size(state.cachePath); } catch {} }
        continue;
      }
      if (state.cachePath) {
        try { freedBytes += await this.storage.size(state.cachePath); } catch {}
        await this.storage.remove(state.cachePath);
        if (node?.kind === "file") clearedPinnedFiles += 1;
      }
      state.cachePath = undefined; state.pinned = false; state.status = "cloud-only"; state.error = undefined;
      this.store.setState(state); changed.push(state.nodeId);
    }
    await this.store.save();
    for (const nodeId of changed) this.emit("nodeChanged", nodeId);
    return { freedBytes, cacheBytes: await this.cacheUsage(), clearedPinnedFiles, retainedUnsafeBytes, retainedUnsafeFiles };
  }
}
