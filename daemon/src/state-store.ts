import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DriveNode, NodeState } from "./domain.ts";

interface Snapshot { version: 1; nodes: Record<string, DriveNode>; states: Record<string, NodeState>; lastEventId?: string; }

export class StateStore {
  private snapshot: Snapshot = { version: 1, nodes: {}, states: {} };
  private saveChain: Promise<void> = Promise.resolve();
  readonly path: string;
  constructor(path: string) { this.path = path; }
  async load(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    try { this.snapshot = JSON.parse(await readFile(this.path, "utf8")) as Snapshot; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (this.snapshot.version !== 1 || !this.snapshot.nodes || !this.snapshot.states) throw new Error("Unsupported or damaged state file");
    try { await chmod(this.path, 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  async save(): Promise<void> {
    const serialized = JSON.stringify(this.snapshot);
    const operation = this.saveChain.catch(() => undefined).then(async () => {
      const temporary = join(dirname(this.path), `.state-${process.pid}.tmp`);
      await writeFile(temporary, serialized, { mode: 0o600 });
      const handle = await open(temporary, "r+"); try { await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.path);
      const directory = await open(dirname(this.path), "r"); try { await directory.sync(); } finally { await directory.close(); }
    });
    this.saveChain = operation; return operation;
  }
  getNode(id: string): DriveNode | undefined { const n = this.snapshot.nodes[id]; return n && structuredClone(n); }
  getNodes(): DriveNode[] { return Object.values(this.snapshot.nodes).map(n => structuredClone(n)); }
  setNode(node: DriveNode): void { this.snapshot.nodes[node.id] = structuredClone(node); }
  deleteNode(id: string): void { delete this.snapshot.nodes[id]; delete this.snapshot.states[id]; }
  getState(id: string): NodeState | undefined { const s = this.snapshot.states[id]; return s && structuredClone(s); }
  getStates(): NodeState[] { return Object.values(this.snapshot.states).map(s => structuredClone(s)); }
  setState(state: NodeState): void { this.snapshot.states[state.nodeId] = structuredClone(state); }
  getLastEventId(): string | undefined { return this.snapshot.lastEventId; }
  setLastEventId(id: string): void { this.snapshot.lastEventId = id; }
}
