import { access, chmod, copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

function safeId(id: string): string {
  if (!/^[A-Za-z0-9._~=-]+$/.test(id) || id === "." || id === "..") throw new Error("Unsafe node id");
  // Proton UIDs can exceed NAME_MAX. Hash long/encoded IDs into a stable,
  // non-secret local filename while the full UID remains in state metadata.
  return /^[A-Za-z0-9._-]+$/.test(id) && id.length <= 100
    ? id
    : `uid-${createHash("sha256").update(id).digest("hex")}`;
}

async function ensurePrivate(path: string): Promise<void> { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result, "utf8") + Buffer.byteLength(character, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
}

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
  conflictPath(id: string, name: string): string {
    const nodeHash = createHash("sha256").update(id).digest("hex").slice(0, 16);
    const nameHash = createHash("sha256").update(name).digest("hex").slice(0, 12);
    const prefix = `${nodeHash}-${Date.now()}-${randomUUID().slice(0, 8)}-`;
    const suffix = `-${nameHash}`;
    const available = 255 - Buffer.byteLength(prefix + suffix, "utf8");
    const label = truncateUtf8(basename(name), available) || "file";
    return join(this.conflicts, `${prefix}${label}${suffix}`);
  }
  async writeAtomic(target: string, bytes: Uint8Array): Promise<void> {
    const dir = dirname(target); await ensurePrivate(dir); const temp = join(dir, `.${basename(target)}-${process.pid}-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, bytes, { mode: 0o600 });
      const handle = await open(temp, "r+"); try { await handle.sync(); } finally { await handle.close(); }
      await rename(temp, target); await syncDirectory(dir);
    } finally { await this.remove(temp); }
  }
  async finalizeDownload(temporary: string, target: string): Promise<void> {
    const handle = await open(temporary, "r+"); try { await handle.sync(); } finally { await handle.close(); }
    await chmod(temporary, 0o600); await rename(temporary, target);
  }
  async stageFrom(source: string, nodeId: string): Promise<string> {
    const target = this.stagingPath(nodeId); const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
    try {
      await copyFile(source, temporary); await chmod(temporary, 0o600);
      const handle = await open(temporary, "r+"); try { await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target); await syncDirectory(dirname(target)); return target;
    } finally { await this.remove(temporary); }
  }
  async stageBytes(bytes: Uint8Array, nodeId: string): Promise<string> { const target = this.stagingPath(nodeId); await this.writeAtomic(target, bytes); return target; }
  async read(path: string): Promise<Uint8Array> { return new Uint8Array(await readFile(path)); }
  async size(path: string): Promise<number> { return (await stat(path)).size; }
  async sameBytes(first: string, second: string): Promise<boolean> {
    const [firstStat, secondStat] = await Promise.all([stat(first), stat(second)]);
    if (firstStat.size !== secondStat.size) return false;
    const [firstHandle, secondHandle] = await Promise.all([open(first, "r"), open(second, "r")]);
    const firstBuffer = Buffer.allocUnsafe(64 * 1024); const secondBuffer = Buffer.allocUnsafe(64 * 1024);
    try {
      let position = 0;
      while (position < firstStat.size) {
        const length = Math.min(firstBuffer.byteLength, firstStat.size - position);
        const [firstRead, secondRead] = await Promise.all([
          firstHandle.read(firstBuffer, 0, length, position),
          secondHandle.read(secondBuffer, 0, length, position),
        ]);
        if (firstRead.bytesRead !== secondRead.bytesRead || !firstBuffer.subarray(0, firstRead.bytesRead).equals(secondBuffer.subarray(0, secondRead.bytesRead))) return false;
        if (firstRead.bytesRead === 0) return position === firstStat.size;
        position += firstRead.bytesRead;
      }
      return true;
    } finally { await Promise.all([firstHandle.close(), secondHandle.close()]); }
  }
  async exists(path?: string): Promise<boolean> { if (!path) return false; try { await access(path); return true; } catch { return false; } }
  async remove(path?: string): Promise<void> { if (!path) return; try { await unlink(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
  async preserveConflict(stagingPath: string, nodeId: string, name: string): Promise<string> { const target = this.conflictPath(nodeId, name); await copyFile(stagingPath, target); await chmod(target, 0o600); return target; }
}
