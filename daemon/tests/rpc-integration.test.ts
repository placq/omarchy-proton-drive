import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";

let root: string | undefined;
let daemon: ChildProcess | undefined;
let runtime: string;
let socketPath: string;
let state: string;
let cache: string;

async function waitForSocket(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(path);
        socket.once("connect", () => { socket.destroy(); resolve(); });
        socket.once("error", reject);
      });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for daemon socket: ${path}`);
}

async function rpc(socketPath: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let input = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", chunk => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      const response = JSON.parse(input.slice(0, newline)) as { result?: unknown; error?: { message: string } };
      if (response.error) reject(new Error(response.error.message));
      else resolve(response.result);
    });
    socket.on("connect", () => socket.write(JSON.stringify({ id: 1, method, params }) + "\n"));
  });
}

async function rawRpc(socketPath: string, payload: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let input = "";
    socket.setEncoding("utf8"); socket.once("error", reject);
    socket.on("data", chunk => {
      input += chunk; const newline = input.indexOf("\n"); if (newline < 0) return;
      socket.destroy(); resolve(JSON.parse(input.slice(0, newline)));
    });
    socket.on("connect", () => socket.write(payload));
  });
}

async function startDaemon(): Promise<void> {
  daemon = spawn("./scripts/node-ts.sh", ["daemon/src/main.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, OMARCHY_DRIVE_PROVIDER: "fake", XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: state, XDG_CACHE_HOME: cache },
    stdio: "ignore"
  });
  await waitForSocket(socketPath);
}

async function stopDaemon(): Promise<void> {
  if (!daemon || daemon.exitCode !== null) return;
  const processToStop = daemon;
  processToStop.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Daemon did not exit within 2 seconds of SIGTERM")), 2_000);
    processToStop.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  daemon = undefined;
}

test("daemon exits promptly on SIGTERM", async () => {
  await createWorkspace();
  const watch = watchEvents();
  await watch.ready;
  await stopDaemon();
  watch.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function createWorkspace(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "omarchy-drive-rpc-"));
  runtime = join(root, "runtime"); socketPath = join(runtime, "omarchy-drive.sock");
  state = join(root, "state"); cache = join(root, "cache");
  await startDaemon();
}

function watchEvents(): { events: any[]; close: () => void; ready: Promise<void> } {
  const events: any[] = [];
  const socket = connect(socketPath);
  let buffer = "";
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (!line) continue;
      const event = JSON.parse(line); events.push(event);
      if (event.event === "Status") resolveReady();
    }
  });
  socket.on("connect", () => socket.write(JSON.stringify({ id: 1, method: "Watch", params: {} }) + "\n"));
  return { events, ready, close: () => socket.destroy() };
}

after(async () => {
  await stopDaemon();
  if (root) await rm(root, { recursive: true, force: true });
});

test("daemon RPC smoke test uses the real process and private XDG state", async () => {
  await createWorkspace();

  const status = await rpc(socketPath, "GetStatus");
  assert.equal(status.connected, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.readOnly, false);
  assert.equal(status.provider, "fake");
  assert.equal(status.account, null);
  assert.equal(status.connectionError, "");
  assert.equal(status.version, "1.0.0");
  assert.equal(status.apiVersion, 1);
  assert.equal(typeof status.checkedAt, "number");
  assert.equal(typeof status.cacheBytes, "number");
  assert.deepEqual(status.transfers, []);
  assert.deepEqual(status.conflicts, []);

  const rootNode = await rpc(socketPath, "GetRoot");
  assert.equal(rootNode.name, "Proton Drive");
  const children = await rpc(socketPath, "ListChildren", { nodeId: "docs" });
  assert.deepEqual(children.map((node: { name: string }) => node.name), ["Welcome.txt"]);
  assert.equal(children[0].localStatus, "cloud-only");
  const lookedUp = await rpc(socketPath, "LookupChild", { parentId: "docs", name: "Welcome.txt" });
  assert.equal(lookedUp.id, "welcome");

  const materialized = await rpc(socketPath, "Materialize", { nodeId: "welcome" });
  assert.match(await readFile(materialized.path, "utf8"), /fake provider/);
});

test("RPC write commits through persistent staging and emits Watch transfer events", async () => {
  const watch = watchEvents();
  await watch.ready;

  const write = await rpc(socketPath, "BeginWrite", { nodeId: "welcome" });
  await writeFile(write.path, "written through the daemon RPC\n", "utf8");
  const queued = await rpc(socketPath, "CommitWrite", { nodeId: "welcome" });
  assert.equal(queued.status, "queued");

  const deadline = Date.now() + 5_000;
  let status;
  while (Date.now() < deadline) {
    status = await rpc(socketPath, "GetNodeStatus", { nodeId: "welcome" });
    if (["cached", "pinned"].includes(status?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(status.status, "cached");
  assert.ok(watch.events.some(event => event.event === "TransferChanged" && event.data.direction === "upload"));
  watch.close();
});

test("CancelTransfer rejects unknown transfers over RPC", async () => {
  await assert.rejects(rpc(socketPath, "CancelTransfer", { transferId: "no-such-transfer" }), /Unknown transfer/);
});

test("malformed RPC values return errors without terminating the daemon", async () => {
  for (const payload of ["null\n", "[]\n", '{"id":1,"method":4,"params":{}}\n', '{"id":1,"method":"GetStatus","params":[]}\n']) {
    const response = await rawRpc(socketPath, payload);
    assert.equal(typeof response.error?.message, "string");
  }
  assert.equal((await rpc(socketPath, "GetStatus")).connected, true);
});

test("daemon restart preserves a dirty staged write", async () => {
  await stopDaemon();
  if (root) await rm(root, { recursive: true, force: true });
  await createWorkspace();
  const write = await rpc(socketPath, "BeginWrite", { nodeId: "welcome" });
  await writeFile(write.path, "survives daemon restart\n", "utf8");
  const beforeRestart = await rpc(socketPath, "GetNodeStatus", { nodeId: "welcome" });
  assert.equal(beforeRestart.status, "dirty");
  assert.equal(typeof beforeRestart.stagingPath, "string");

  await stopDaemon();
  await startDaemon();
  const afterRestart = await rpc(socketPath, "GetNodeStatus", { nodeId: "welcome" });
  assert.equal(afterRestart.status, "dirty");
  assert.equal(afterRestart.stagingPath, beforeRestart.stagingPath);

  const queued = await rpc(socketPath, "CommitWrite", { nodeId: "welcome" });
  assert.equal(queued.status, "queued");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await rpc(socketPath, "GetNodeStatus", { nodeId: "welcome" });
    if (current.status === "cached") break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const finalState = await rpc(socketPath, "GetNodeStatus", { nodeId: "welcome" });
  assert.equal(finalState.status, "cached");
  assert.match(await readFile(finalState.cachePath, "utf8"), /survives daemon restart/);
});
