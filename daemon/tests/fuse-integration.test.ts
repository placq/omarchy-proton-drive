import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";

const python = process.env.PYTHON ?? "python3";
const fuseScript = join(process.cwd(), "filesystem/fuse/omarchy-drive-fuse.py");
const fuseAvailable = (() => {
  try {
    execFileSync(python, ["-c", "import pyfuse3, trio"], { stdio: "ignore" });
    execFileSync("fusermount3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

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
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForMount(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      execFileSync("mountpoint", ["-q", path], { stdio: "ignore" });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for FUSE mount ${path}`);
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

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

test("FUSE filesystem supports browse, open, upload, rename, move and delete", { skip: !fuseAvailable }, async () => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-drive-fuse-"));
  const runtime = join(root, "runtime");
  const mount = join(root, "mount");
  const state = join(root, "state");
  const cache = join(root, "cache");
  const socketPath = join(runtime, "omarchy-drive.sock");
  const env = { ...process.env, OMARCHY_DRIVE_PROVIDER: "fake", XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: state, XDG_CACHE_HOME: cache };
  let daemon: ChildProcess | undefined;
  let fuse: ChildProcess | undefined;

  try {
    daemon = spawn(process.execPath, ["--experimental-transform-types", "daemon/src/main.ts"], { cwd: process.cwd(), env, stdio: "ignore" });
    await waitForSocket(socketPath);
    fuse = spawn(python, [fuseScript, mount, "--socket", socketPath], { cwd: process.cwd(), env, stdio: "ignore" });
    await waitForMount(mount);

    assert.deepEqual((await readdir(mount)).sort(), ["Documents"]);
    assert.match(await readFile(join(mount, "Documents/Welcome.txt"), "utf8"), /fake provider/);

    await writeFile(join(mount, "Documents/upload.txt"), "uploaded through FUSE\n", "utf8");
    const children = await rpc(socketPath, "ListChildren", { nodeId: "docs" });
    const uploaded = children.find((node: { name: string }) => node.name === "upload.txt");
    assert.ok(uploaded);
    assert.equal(await readFile(join(mount, "Documents/upload.txt"), "utf8"), "uploaded through FUSE\n");

    await rename(join(mount, "Documents/upload.txt"), join(mount, "Documents/renamed.txt"));
    await mkdir(join(mount, "Documents/Moved"));
    await rename(join(mount, "Documents/renamed.txt"), join(mount, "Documents/Moved/renamed.txt"));
    assert.equal(await readFile(join(mount, "Documents/Moved/renamed.txt"), "utf8"), "uploaded through FUSE\n");
    await unlink(join(mount, "Documents/Moved/renamed.txt"));
    await assert.rejects(readFile(join(mount, "Documents/Moved/renamed.txt")));
  } finally {
    try { execFileSync("fusermount3", ["-u", mount], { stdio: "ignore" }); } catch { /* already unmounted */ }
    await stopProcess(fuse);
    await stopProcess(daemon);
    await rm(root, { recursive: true, force: true });
  }
});
