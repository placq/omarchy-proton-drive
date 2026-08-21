import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { DriveNode, NodeState } from "./domain.ts";

interface Snapshot { version: 1; nodes: Record<string, DriveNode>; states: Record<string, NodeState>; lastEventId?: string; }
interface StatementLike {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface DatabaseLike { exec(sql: string): unknown; prepare(sql: string): StatementLike; close?(): void; }
interface StoreStatements {
  upsertNode: StatementLike;
  deleteNode: StatementLike;
  upsertState: StatementLike;
  deleteState: StatementLike;
  upsertEventId: StatementLike;
  deleteEventId: StatementLike;
}

async function openDatabase(path: string): Promise<DatabaseLike> {
  const moduleName = typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? "node:sqlite" : "bun:sqlite";
  const sqlite = await import(moduleName) as Record<string, new (path: string, options?: Record<string, unknown>) => DatabaseLike>;
  const Constructor = sqlite.DatabaseSync ?? sqlite.Database;
  if (!Constructor) throw new Error(`SQLite runtime unavailable: ${moduleName}`);
  return new Constructor(path, { create: true });
}

async function makeDatabaseFilesPrivate(path: string): Promise<void> {
  await Promise.all([path, `${path}-wal`, `${path}-shm`].map(async candidate => {
    try { await chmod(candidate, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }));
}

export class StateStore {
  private snapshot: Snapshot = { version: 1, nodes: {}, states: {} };
  private saveChain: Promise<void> = Promise.resolve();
  private database?: DatabaseLike;
  private statements?: StoreStatements;
  private readonly childrenByParent = new Map<string | null, Set<string>>();
  private readonly childByName = new Map<string | null, Map<string, string>>();
  private readonly dirtyNodes = new Map<string, DriveNode | null>();
  private readonly dirtyStates = new Map<string, NodeState | null>();
  private eventIdDirty = false;
  readonly path: string;
  readonly legacyPath: string;
  constructor(path: string, legacyPath?: string) {
    this.path = path;
    this.legacyPath = legacyPath ?? (extname(path) === ".sqlite" ? path.replace(/\.sqlite$/, ".json") : `${path}.legacy.json`);
  }
  async load(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    this.database = await openDatabase(this.path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.database.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS states (node_id TEXT PRIMARY KEY, json TEXT NOT NULL); PRAGMA user_version=1; COMMIT;");
    this.statements = {
      upsertNode: this.database.prepare("INSERT INTO nodes (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json"),
      deleteNode: this.database.prepare("DELETE FROM nodes WHERE id=?"),
      upsertState: this.database.prepare("INSERT INTO states (node_id, json) VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET json=excluded.json"),
      deleteState: this.database.prepare("DELETE FROM states WHERE node_id=?"),
      upsertEventId: this.database.prepare("INSERT INTO metadata (key, value) VALUES ('last_event_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
      deleteEventId: this.database.prepare("DELETE FROM metadata WHERE key='last_event_id'"),
    };
    await makeDatabaseFilesPrivate(this.path);
    const rows = this.database.prepare("SELECT id, json FROM nodes").all();
    const stateRows = this.database.prepare("SELECT node_id, json FROM states").all();
    const eventRow = this.database.prepare("SELECT value FROM metadata WHERE key='last_event_id'").get();
    if (rows.length || stateRows.length || eventRow) {
      this.snapshot = { version: 1, nodes: {}, states: {}, lastEventId: eventRow ? String(eventRow.value) : undefined };
      for (const row of rows) this.snapshot.nodes[String(row.id)] = JSON.parse(String(row.json)) as DriveNode;
      for (const row of stateRows) this.snapshot.states[String(row.node_id)] = JSON.parse(String(row.json)) as NodeState;
      this.rebuildIndexes();
      return;
    }
    try {
      const legacy = JSON.parse(await readFile(this.legacyPath, "utf8")) as Snapshot;
      if (legacy.version !== 1 || !legacy.nodes || !legacy.states) throw new Error("Unsupported legacy state file");
      this.snapshot = legacy;
      this.rebuildIndexes();
      for (const node of Object.values(this.snapshot.nodes)) this.dirtyNodes.set(node.id, structuredClone(node));
      for (const state of Object.values(this.snapshot.states)) this.dirtyStates.set(state.nodeId, structuredClone(state));
      this.eventIdDirty = this.snapshot.lastEventId !== undefined;
      await this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async save(): Promise<void> {
    if (!this.dirtyNodes.size && !this.dirtyStates.size && !this.eventIdDirty) return this.saveChain;
    const operation = this.saveChain.catch(() => undefined).then(() => this.flushDirty());
    this.saveChain = operation;
    return operation;
  }
  private async flushDirty(): Promise<void> {
    const nodes = new Map(this.dirtyNodes); this.dirtyNodes.clear();
    const states = new Map(this.dirtyStates); this.dirtyStates.clear();
    const eventIdDirty = this.eventIdDirty; this.eventIdDirty = false;
    const eventId = this.snapshot.lastEventId;
    if (!nodes.size && !states.size && !eventIdDirty) return;
    const database = this.database;
    const statements = this.statements;
    if (!database || !statements) {
      for (const [id, node] of nodes) this.dirtyNodes.set(id, node);
      for (const [id, state] of states) this.dirtyStates.set(id, state);
      if (eventIdDirty) this.eventIdDirty = true;
      throw new Error("StateStore is not loaded");
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const [id, node] of nodes) node ? statements.upsertNode.run(id, JSON.stringify(node)) : statements.deleteNode.run(id);
      for (const [id, state] of states) state ? statements.upsertState.run(id, JSON.stringify(state)) : statements.deleteState.run(id);
      if (eventIdDirty) {
        if (eventId === undefined) statements.deleteEventId.run();
        else statements.upsertEventId.run(eventId);
      }
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* preserve the original transaction failure */ }
      for (const [id, node] of nodes) if (!this.dirtyNodes.has(id)) this.dirtyNodes.set(id, node);
      for (const [id, state] of states) if (!this.dirtyStates.has(id)) this.dirtyStates.set(id, state);
      if (eventIdDirty) this.eventIdDirty = true;
      throw error;
    }
  }
  private addToIndexes(node: DriveNode): void {
    let children = this.childrenByParent.get(node.parentId);
    if (!children) { children = new Set(); this.childrenByParent.set(node.parentId, children); }
    children.add(node.id);
    let names = this.childByName.get(node.parentId);
    if (!names) { names = new Map(); this.childByName.set(node.parentId, names); }
    names.set(node.name, node.id);
  }
  private removeFromIndexes(node: DriveNode): void {
    const children = this.childrenByParent.get(node.parentId); children?.delete(node.id);
    if (children?.size === 0) this.childrenByParent.delete(node.parentId);
    const names = this.childByName.get(node.parentId);
    if (names?.get(node.name) === node.id) names.delete(node.name);
    if (names?.size === 0) this.childByName.delete(node.parentId);
  }
  private rebuildIndexes(): void {
    this.childrenByParent.clear(); this.childByName.clear();
    for (const node of Object.values(this.snapshot.nodes)) this.addToIndexes(node);
  }
  getNode(id: string): DriveNode | undefined { const n = this.snapshot.nodes[id]; return n && structuredClone(n); }
  getNodes(): DriveNode[] { return Object.values(this.snapshot.nodes).map(n => structuredClone(n)); }
  getRoot(): DriveNode | undefined { const id = this.childrenByParent.get(null)?.values().next().value as string | undefined; return id ? this.getNode(id) : undefined; }
  getChildren(parentId: string): DriveNode[] { return [...(this.childrenByParent.get(parentId) ?? [])].map(id => structuredClone(this.snapshot.nodes[id]!)); }
  findChild(parentId: string, name: string): DriveNode | undefined { const id = this.childByName.get(parentId)?.get(name); return id ? this.getNode(id) : undefined; }
  setNode(node: DriveNode): void {
    const previous = this.snapshot.nodes[node.id]; if (previous) this.removeFromIndexes(previous);
    const copy = structuredClone(node); this.snapshot.nodes[node.id] = copy; this.addToIndexes(copy); this.dirtyNodes.set(node.id, structuredClone(copy));
  }
  deleteNode(id: string): void {
    const node = this.snapshot.nodes[id]; if (node) this.removeFromIndexes(node);
    delete this.snapshot.nodes[id]; delete this.snapshot.states[id]; this.dirtyNodes.set(id, null); this.dirtyStates.set(id, null);
  }
  getState(id: string): NodeState | undefined { const s = this.snapshot.states[id]; return s && structuredClone(s); }
  getStates(): NodeState[] { return Object.values(this.snapshot.states).map(s => structuredClone(s)); }
  setState(state: NodeState): void { const copy = structuredClone(state); this.snapshot.states[state.nodeId] = copy; this.dirtyStates.set(state.nodeId, structuredClone(copy)); }
  getLastEventId(): string | undefined { return this.snapshot.lastEventId; }
  setLastEventId(id: string): void { this.snapshot.lastEventId = id; this.eventIdDirty = true; }
}
