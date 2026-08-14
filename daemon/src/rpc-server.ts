import { createServer, type Socket } from "node:net";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { DriveEngine } from "./engine.ts";

interface Request { id: string | number; method: string; params?: Record<string, unknown>; }

// SDK node UIDs are two URL-safe base64 components separated by `~` and may
// retain `=` padding. Path separators, whitespace and shell metacharacters
// remain forbidden.
const SAFE_ID = /^[A-Za-z0-9._~=-]+$/;
const MAX_NAME_LENGTH = 255;

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`Invalid ${field}`);
  return value;
}

function requiredName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_NAME_LENGTH || value.includes("\0") || value === "." || value === ".." || value.includes("/")) {
    throw new Error("Invalid node name");
  }
  return value;
}

export class RpcServer {
  readonly engine: DriveEngine;
  readonly socketPath: string;
  constructor(engine: DriveEngine, socketPath: string) {
    this.engine = engine;
    this.socketPath = socketPath;
  }
  async listen(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    try { await unlink(this.socketPath); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      this.handleSocket(socket);
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.socketPath, () => resolve()); });
    await chmod(this.socketPath, 0o600);
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      // Stop accepting first. Otherwise a FUSE/DBus client can reconnect in
      // the gap between destroying the current sockets and server.close(),
      // leaving systemd stuck waiting for SIGTERM shutdown forever.
      server.close();
      for (const socket of sockets) socket.destroy();
      process.exit(0);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }
  private handleSocket(socket: Socket): void {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      input += chunk;
      if (input.length > 1024 * 1024) { socket.end(JSON.stringify({ id: null, error: { code: "REQUEST_TOO_LARGE", message: "RPC request exceeds 1 MiB" } }) + "\n"); return; }
      let at: number; while ((at = input.indexOf("\n")) >= 0) { const line = input.slice(0, at); input = input.slice(at + 1); if (line.trim()) void this.reply(socket, line); }
    });
  }
  private async reply(socket: Socket, line: string): Promise<void> {
    let request: Request;
    try { request = JSON.parse(line) as Request; } catch { socket.end(JSON.stringify({ id: null, error: { code: "BAD_JSON", message: "Invalid JSON" } }) + "\n"); return; }
    if (request.method === "Watch") {
      const write = (event: string, data: unknown) => socket.write(JSON.stringify({ event, data }) + "\n");
      const nodeChanged = (nodeId: string) => write("NodeChanged", { nodeId });
      const transferChanged = (transfer: unknown) => write("TransferChanged", transfer);
      this.engine.on("nodeChanged", nodeChanged); this.engine.transfers.on("changed", transferChanged);
      socket.on("close", () => { this.engine.off("nodeChanged", nodeChanged); this.engine.transfers.off("changed", transferChanged); });
      write("Status", await this.dispatch("GetStatus", {})); return;
    }
    try { socket.end(JSON.stringify({ id: request.id, result: await this.dispatch(request.method, request.params ?? {}) }) + "\n"); }
    catch (e) { socket.end(JSON.stringify({ id: request.id, error: { code: e instanceof Error ? e.name : "ERROR", message: e instanceof Error ? e.message : String(e) } }) + "\n"); }
  }
  private async dispatch(method: string, p: Record<string, unknown>): Promise<unknown> {
    const id = () => requiredId(p.nodeId, "nodeId");
    switch (method) {
      case "GetVersion": return { version: "0.2.0-alpha.1", apiVersion: 1, provider: this.engine.provider.kind };
      case "GetStatus": {
        let account = null; let connectionError = "";
        try { account = await this.engine.provider.getAccountInfo?.() ?? null; }
        catch { connectionError = "Nie udało się połączyć z Proton Drive."; }
        const authenticated = this.engine.provider.kind === "fake" || account !== null;
        return {
          connected: authenticated && connectionError === "", authenticated,
          readOnly: this.engine.provider.kind === "proton-cli", provider: this.engine.provider.kind,
          account, connectionError, checkedAt: Date.now(), cacheBytes: await this.engine.cacheUsage(),
          version: "0.2.0-alpha.1", transfers: this.engine.transfers.list(true),
        };
      }
      case "GetRoot": return this.engine.root();
      case "GetNode": return this.engine.getNode(id());
      case "ListChildren": return this.engine.listChildren(id());
      case "GetNodeStatus": return this.engine.getState(id()) ?? null;
      case "Materialize": return { path: await this.engine.materialize(id()) };
      case "BeginWrite": return { path: await this.engine.beginWrite(id()) };
      case "CommitWrite": return this.engine.queueCommit(id());
      case "SetPinned": return this.engine.pin(id(), Boolean(p.pinned));
      case "Evict": return this.engine.evict(id());
      case "Retry": return this.engine.queueCommit(id());
      case "CreateFolder": return this.engine.createFolder(requiredId(p.parentId, "parentId"), requiredName(p.name));
      case "CreateFile": return this.engine.createFile(requiredId(p.parentId, "parentId"), requiredName(p.name), new Uint8Array());
      case "Rename": return this.engine.rename(id(), requiredName(p.name));
      case "Move": return this.engine.move(id(), requiredId(p.parentId, "parentId"));
      case "Trash": await this.engine.trash(id()); return null;
      case "GetTransfers": return this.engine.transfers.list();
      case "Sync": await this.engine.syncQueued(); await this.engine.processEvents(); return null;
      case "ClearCache": return this.engine.clearDisposableCache();
      default: throw new Error(`Unknown method: ${method}`);
    }
  }
}
