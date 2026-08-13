import { access, chmod, copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

function safeId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") throw new Error("Unsafe node id");
  return id;
}

async function ensurePrivate(path: string): Promise<void> { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }

export class LocalStorage {
  readonly cacheContent: string;
  readonly staging: string;
  readonly conflicts: string;
  constructor(cacheRoot: string, stateRoot: string) {
    this.cacheContent = join(resolve(cacheRoot), "content");
    this.staging = join(resolve(stateRoot), "staging");
    this.conflicts = join(resolve(stateRoot), "conflicts");
  }
  async initialize(): Promise<void> { await Promise.all([ensurePrivate(this.cacheContent), ensurePrivate(this.staging), ensurePrivate(this.conflicts)]); }
  cachePath(id: string): string { return join(this.cacheContent, safeId(id)); }
  downloadPath(id: string): string { return join(this.cacheContent, `.${safeId(id)}-${process.pid}.download`); }
  stagingPath(id: string): string { return join(this.staging, safeId(id)); }
  conflictPath(id: string, name: string): string { return join(this.conflicts, `${safeId(id)}-${Date.now()}-${basename(name)}`); }
  async writeAtomic(target: string, bytes: Uint8Array): Promise<void> {
    const dir = dirname(target); await ensurePrivate(dir); const temp = join(dir, `.${basename(target)}-${process.pid}.tmp`);
    await writeFile(temp, bytes, { mode: 0o600 });
    const handle = await open(temp, "r+"); try { await handle.sync(); } finally { await handle.close(); }
    await rename(temp, target);
  }
  async finalizeDownload(temporary: string, target: string): Promise<void> {
    const handle = await open(temporary, "r+"); try { await handle.sync(); } finally { await handle.close(); }
    await chmod(temporary, 0o600); await rename(temporary, target);
  }
  async stageFrom(source: string, nodeId: string): Promise<string> { const target = this.stagingPath(nodeId); await copyFile(source, target); await chmod(target, 0o600); return target; }
  async stageBytes(bytes: Uint8Array, nodeId: string): Promise<string> { const target = this.stagingPath(nodeId); await this.writeAtomic(target, bytes); return target; }
  async read(path: string): Promise<Uint8Array> { return new Uint8Array(await readFile(path)); }
  async size(path: string): Promise<number> { return (await stat(path)).size; }
  async exists(path?: string): Promise<boolean> { if (!path) return false; try { await access(path); return true; } catch { return false; } }
  async remove(path?: string): Promise<void> { if (!path) return; try { await unlink(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
  async preserveConflict(stagingPath: string, nodeId: string, name: string): Promise<string> { const target = this.conflictPath(nodeId, name); await copyFile(stagingPath, target); await chmod(target, 0o600); return target; }
}
