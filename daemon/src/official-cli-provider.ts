import { execFile } from "node:child_process";
import { chmod, copyFile, link, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { DriveEvent, DriveNode } from "./domain.ts";
import { AuthenticationRequiredError, ConflictError, OfflineError } from "./domain.ts";
import type { AccountInfo, DownloadResult, DriveProvider, RequestPriority, UploadInput } from "./provider.ts";
import { positiveIntegerSetting } from "./settings.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_CLI_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CLI_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
type CliNode = Record<string, unknown>;
type CliRunner = (args: string[]) => Promise<unknown>;
interface CliJob {
  args: string[];
  signal?: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export function cliExecutionLimits(environment: NodeJS.ProcessEnv = process.env): { timeoutMs: number; maxBufferBytes: number } {
  return {
    timeoutMs: positiveIntegerSetting("OMARCHY_DRIVE_CLI_TIMEOUT_MS", DEFAULT_CLI_TIMEOUT_MS, environment),
    maxBufferBytes: positiveIntegerSetting("OMARCHY_DRIVE_CLI_MAX_BUFFER_BYTES", DEFAULT_CLI_MAX_BUFFER_BYTES, environment),
  };
}

function resultString(value: unknown): string {
  if (value && typeof value === "object" && "ok" in value) {
    const result = value as { ok: boolean; value?: unknown; error?: unknown };
    if (!result.ok) throw new Error(`Proton could not decrypt a node name: ${String(result.error ?? "unknown error")}`);
    return String(result.value ?? "");
  }
  return String(value ?? "");
}

function revisionOf(node: CliNode): string {
  const revision = node.activeRevision as Record<string, unknown> | undefined;
  return String(revision?.uid ?? node.uid ?? "");
}

function sizeOf(node: CliNode): number {
  const revision = node.activeRevision as Record<string, unknown> | undefined;
  return Number(revision?.claimedSize ?? revision?.storageSize ?? node.totalStorageSize ?? 0);
}

/** Real-account provider backed by Proton's official CLI and OS-secret session. */
export class OfficialCliProvider implements DriveProvider {
  readonly kind = "proton-cli" as const;
  readonly progressSupported = false;
  private readonly paths = new Map<string, string>();
  private readonly cliPath: string;
  private readonly runner?: CliRunner;
  private readonly interactiveJobs: CliJob[] = [];
  private readonly backgroundJobs: CliJob[] = [];
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;
  private commandRunning = false;

  constructor(cliPath: string, runner?: CliRunner) {
    this.cliPath = cliPath;
    this.runner = runner;
    ({ timeoutMs: this.timeoutMs, maxBufferBytes: this.maxBufferBytes } = cliExecutionLimits());
  }

  primeNodes(nodes: DriveNode[]): void {
    const pending = new Map(nodes.map(node => [node.id, node]));
    for (const node of nodes) {
      if (node.parentId === null) { this.paths.set(node.id, "/my-files"); pending.delete(node.id); }
    }
    let progressed = true;
    while (pending.size && progressed) {
      progressed = false;
      for (const [id, node] of pending) {
        const parentPath = node.parentId ? this.paths.get(node.parentId) : undefined;
        if (!parentPath) continue;
        this.paths.set(id, this.childPath(parentPath, node.name)); pending.delete(id); progressed = true;
      }
    }
  }

  async getAccountInfo(priority: RequestPriority = "interactive"): Promise<AccountInfo | null> {
    try {
      const value = await this.run(["account", "info", "-j"], priority) as Record<string, unknown>;
      return {
        email: String(value.email ?? ""),
        displayName: String(value.displayName ?? "") || undefined,
        usedBytes: Math.max(0, Number(value.usedBytes ?? 0)),
        totalBytes: Math.max(0, Number(value.totalBytes ?? 0)),
      };
    } catch (error) {
      if (error instanceof AuthenticationRequiredError) return null;
      throw error;
    }
  }

  private classifiedError(error: unknown): Error {
    if (error instanceof AuthenticationRequiredError || error instanceof OfflineError || error instanceof ConflictError) return error;
    const detail = error as Error & { stderr?: string; stdout?: string; code?: string | number };
    const raw = [detail.stderr, detail.stdout, detail.message].filter(Boolean).join("\n");
    const lower = raw.toLowerCase();
    if (["need to login", "not logged in", "unauthenticated", "unauthorized", "session expired", "session revoked", "invalid refresh token"].some(marker => lower.includes(marker)) || /\b401\b/.test(lower)) {
      return new AuthenticationRequiredError();
    }
    if (["network", "timed out", "timeout", "fetch failed", "connection", "temporarily unavailable", "rate limit", "too many requests"].some(marker => lower.includes(marker)) || /\b429\b/.test(lower)) {
      return new OfflineError("Official Proton Drive CLI is temporarily unavailable");
    }
    const exitCode = detail.code === undefined ? "" : ` (exit code ${String(detail.code)})`;
    // CLI output may contain personal names or paths. Keep it out of state,
    // D-Bus responses and the journal while retaining a useful failure class.
    return new Error(`Official Proton Drive CLI operation failed${exitCode}`);
  }

  private run(args: string[], priority: RequestPriority = "interactive", signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const queue = priority === "interactive" ? this.interactiveJobs : this.backgroundJobs;
      queue.push({ args, signal, resolve, reject });
      this.drainCommands();
    });
  }

  private drainCommands(): void {
    if (this.commandRunning) return;
    const job = this.interactiveJobs.shift() ?? this.backgroundJobs.shift();
    if (!job) return;
    this.commandRunning = true;
    void this.runNow(job.args, job.signal).then(job.resolve, job.reject).finally(() => {
      this.commandRunning = false;
      this.drainCommands();
    });
  }

  private async runNow(args: string[], signal?: AbortSignal): Promise<unknown> {
    try {
      if (this.runner) return await this.runner(args);
      const { stdout } = await execFileAsync(this.cliPath, args, {
        encoding: "utf8", maxBuffer: this.maxBufferBytes, timeout: this.timeoutMs, signal,
      });
      return JSON.parse(stdout);
    } catch (error) { throw this.classifiedError(error); }
  }

  private map(raw: CliNode, path: string, parentId: string | null): DriveNode {
    const id = String(raw.uid ?? "");
    if (!id) throw new Error("Official Proton Drive CLI returned a node without uid");
    this.paths.set(id, path);
    return {
      id, parentId,
      name: path === "/my-files" ? "Proton Drive" : resultString(raw.name),
      kind: String(raw.type).toLowerCase() === "folder" ? "folder" : "file",
      size: sizeOf(raw),
      modifiedAt: new Date(String(raw.modificationTime ?? raw.creationTime ?? Date.now())).getTime(),
      revision: revisionOf(raw),
    };
  }

  private childPath(parentPath: string, name: string): string {
    const escaped = name.replaceAll("\\", "\\\\").replaceAll("/", "\\/");
    return `${parentPath.replace(/\/$/, "")}/${escaped}`;
  }

  private async pathFor(nodeId: string): Promise<string> {
    const known = this.paths.get(nodeId);
    if (known) return known;
    const root = await this.getRoot();
    if (root.id === nodeId) return "/my-files";
    const queue = [root];
    while (queue.length) {
      const parent = queue.shift()!;
      for (const child of await this.listChildren(parent.id)) {
        if (child.id === nodeId) return this.paths.get(nodeId)!;
        if (child.kind === "folder") queue.push(child);
      }
    }
    throw new Error(`Proton Drive node is no longer available: ${nodeId}`);
  }

  private rebasePaths(oldPrefix: string, newPrefix: string): void {
    for (const [id, path] of this.paths) {
      if (path === oldPrefix || path.startsWith(`${oldPrefix}/`)) {
        this.paths.set(id, `${newPrefix}${path.slice(oldPrefix.length)}`);
      }
    }
  }

  async getRoot(priority: RequestPriority = "interactive"): Promise<DriveNode> {
    return this.map(await this.run(["filesystem", "info", "-j", "/my-files"], priority) as CliNode, "/my-files", null);
  }

  async getNode(nodeId: string): Promise<DriveNode> {
    const path = await this.pathFor(nodeId);
    const raw = await this.run(["filesystem", "info", "-j", path]) as CliNode;
    return this.map(raw, path, path === "/my-files" ? null : String(raw.parentUid ?? "") || null);
  }

  async listChildren(parentId: string, priority: RequestPriority = "interactive"): Promise<DriveNode[]> {
    const parentPath = await this.pathFor(parentId);
    const raw = await this.run(["filesystem", "list", "-j", parentPath], priority);
    if (!Array.isArray(raw)) throw new Error("Official Proton Drive CLI returned an invalid folder listing");
    return raw.map(value => {
      const node = value as CliNode;
      return this.map(node, this.childPath(parentPath, resultString(node.name)), parentId);
    });
  }

  async downloadToPath(nodeId: string, targetPath: string, onProgress?: (done: number, total: number) => void, _knownNode?: DriveNode): Promise<DownloadResult> {
    const node = await this.getNode(nodeId);
    if (node.kind !== "file") throw new Error("Cannot download a folder as a file");
    const temporary = await mkdtemp(join(dirname(targetPath), ".proton-cli-download-"));
    try {
      await this.run(["filesystem", "download", "-j", "-f", "remove", await this.pathFor(nodeId), temporary]);
      const entries = await readdir(temporary);
      if (entries.length !== 1) throw new Error(`Official Proton Drive CLI produced ${entries.length} download entries`);
      await rename(join(temporary, entries[0]!), targetPath);
      await chmod(targetPath, 0o600);
      const confirmed = await this.getNode(nodeId);
      if (confirmed.revision !== node.revision) throw new ConflictError("Remote revision changed while downloading");
      onProgress?.(node.size, node.size);
      return { revision: node.revision };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async childByName(parentId: string, name: string): Promise<DriveNode> {
    const child = (await this.listChildren(parentId)).find(node => node.name === name);
    if (!child) throw new Error(`Proton Drive did not return the changed node: ${name}`);
    return child;
  }

  private async mutation(args: string[], signal?: AbortSignal): Promise<void> {
    await this.run([...args, "-j"], "interactive", signal);
  }

  async upload(input: UploadInput): Promise<DriveNode> {
    const parentPath = await this.pathFor(input.parentId);
    if (!input.nodeId && (await this.listChildren(input.parentId)).some(node => node.name === input.name)) {
      throw new Error(`A Proton Drive node named ${input.name} already exists`);
    }
    const strategy = input.nodeId ? "create-new-revision" : "skip";
    if (basename(input.name) !== input.name) throw new Error("The official CLI cannot upload a local file whose Proton Drive name contains a slash");
    const uploadDirectory = await mkdtemp(join(dirname(input.sourcePath), ".proton-cli-upload-"));
    const namedSource = join(uploadDirectory, input.name);
    try {
      try { await link(input.sourcePath, namedSource); }
      catch { await copyFile(input.sourcePath, namedSource); }
      await chmod(namedSource, 0o600);
      if (input.nodeId && input.expectedRevision) {
        input.signal?.throwIfAborted();
        // Do not trust the engine's earlier snapshot here. Refresh only after
        // all local preparation, immediately before the CLI mutation.
        const remote = await this.getNode(input.nodeId);
        if (remote.revision !== input.expectedRevision) throw new ConflictError();
      }
      await this.mutation(["filesystem", "upload", "-f", strategy, "-t", namedSource, parentPath], input.signal);
    } finally {
      await rm(uploadDirectory, { recursive: true, force: true });
    }
    input.onProgress?.(input.expectedSize, input.expectedSize);
    if (input.nodeId) return this.getNode(input.nodeId);
    return this.childByName(input.parentId, input.name);
  }

  async createFolder(parentId: string, name: string, signal?: AbortSignal): Promise<DriveNode> {
    await this.mutation(["filesystem", "create-folder", await this.pathFor(parentId), name], signal);
    return this.childByName(parentId, name);
  }

  async rename(nodeId: string, name: string, knownNode?: DriveNode, signal?: AbortSignal): Promise<DriveNode> {
    const current = knownNode ?? await this.getNode(nodeId);
    const oldPath = await this.pathFor(nodeId);
    if (!current.parentId) throw new Error("The Proton Drive root cannot be renamed");
    const parentPath = await this.pathFor(current.parentId);
    await this.mutation(["filesystem", "rename", oldPath, name], signal);
    this.rebasePaths(oldPath, this.childPath(parentPath, name));
    return this.getNode(nodeId);
  }

  async move(nodeId: string, parentId: string, knownNode?: DriveNode, signal?: AbortSignal): Promise<DriveNode> {
    const current = knownNode ?? await this.getNode(nodeId);
    const nodePath = await this.pathFor(nodeId);
    const parentPath = await this.pathFor(parentId);
    await this.mutation(["filesystem", "move", nodePath, parentPath], signal);
    this.rebasePaths(nodePath, this.childPath(parentPath, current.name));
    return this.getNode(nodeId);
  }

  async trash(nodeId: string, signal?: AbortSignal): Promise<void> {
    const path = await this.pathFor(nodeId);
    await this.mutation(["filesystem", "trash", path], signal);
    for (const [id, cached] of this.paths) if (cached === path || cached.startsWith(`${path}/`)) this.paths.delete(id);
  }

  async *getEvents(_afterId?: string): AsyncIterable<DriveEvent> {
    // The CLI persists the SDK event cursor internally and does not expose an
    // event stream. Emit a non-persisted refresh marker so the daemon keeps
    // the visible root current without inventing an external cursor.
    yield { id: "none", type: "refresh", nodeId: "root" };
  }
}
