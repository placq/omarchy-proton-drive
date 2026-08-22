import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
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

async function waitForFile(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { if (await readFile(path, "utf8") === expected) return; } catch { /* retry while the FUSE release is queued */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(await readFile(path, "utf8"), expected);
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

test("FUSE waits for daemon startup and handles operations plus hostile names", { skip: !fuseAvailable }, async () => {
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
    fuse = spawn(python, [fuseScript, mount, "--socket", socketPath], { cwd: process.cwd(), env, stdio: "ignore" });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(fuse.exitCode, null, "FUSE must wait instead of failing while the daemon starts");
    daemon = spawn("./scripts/node-ts.sh", ["daemon/src/main.ts"], { cwd: process.cwd(), env, stdio: "ignore" });
    await waitForSocket(socketPath);
    await waitForMount(mount);

    assert.deepEqual((await readdir(mount)).sort(), ["Documents"]);
    assert.match(await readFile(join(mount, "Documents/Welcome.txt"), "utf8"), /fake provider/);
    const genericTrash = spawnSync("gio", ["trash", join(mount, "Documents/Welcome.txt")], { encoding: "utf8" });
    assert.notEqual(genericTrash.status, 0);
    assert.doesNotMatch((await readdir(mount)).join("\n"), /^\.Trash(?:-|$)/m);
    assert.match(await readFile(join(mount, "Documents/Welcome.txt"), "utf8"), /fake provider/);

    await writeFile(join(mount, "Documents/upload.txt"), "uploaded through FUSE\n", "utf8");
    const children = await rpc(socketPath, "ListChildren", { nodeId: "docs" });
    const uploaded = children.find((node: { name: string }) => node.name === "upload.txt");
    assert.ok(uploaded);
    assert.equal(await readFile(join(mount, "Documents/upload.txt"), "utf8"), "uploaded through FUSE\n");

    await writeFile(join(mount, "Documents/.atomic-save.tmp"), "desktop atomic save\n", "utf8");
    await rename(join(mount, "Documents/.atomic-save.tmp"), join(mount, "Documents/Welcome.txt"));
    assert.equal(await readFile(join(mount, "Documents/Welcome.txt"), "utf8"), "desktop atomic save\n");
    const afterAtomicSave = await rpc(socketPath, "ListChildren", { nodeId: "docs" });
    assert.equal(afterAtomicSave.filter((node: { name: string }) => node.name === "Welcome.txt").length, 1);
    assert.equal(afterAtomicSave.some((node: { name: string }) => node.name === ".atomic-save.tmp"), false);

    const decomposedName = "e\u0301.txt";
    const normalizedName = decomposedName.normalize("NFC");
    await writeFile(join(mount, "Documents", decomposedName), "normalized\n", "utf8");
    assert.ok((await readdir(join(mount, "Documents"))).includes(normalizedName));
    const normalizedChildren = await rpc(socketPath, "ListChildren", { nodeId: "docs" });
    const normalizedNode = normalizedChildren.find((node: { name: string }) => node.name === normalizedName);
    assert.ok(normalizedNode);
    const normalizedState = await rpc(socketPath, "GetNodeStatus", { nodeId: normalizedNode.id });
    const normalizedLocal = await rpc(socketPath, "Materialize", { nodeId: normalizedNode.id });
    assert.equal(await readFile(normalizedLocal.path, "utf8"), "normalized\n", JSON.stringify(normalizedState));
    await waitForFile(join(mount, "Documents", normalizedName), "normalized\n");
    await unlink(join(mount, "Documents", normalizedName));

    await assert.rejects(writeFile(join(mount, "Documents", "ą".repeat(128)), "too long"));
    const invalidUtf8Path = Buffer.concat([Buffer.from(`${join(mount, "Documents")}/invalid-`), Buffer.from([0x80])]);
    await assert.rejects(writeFile(invalidUtf8Path, "invalid UTF-8"));
    await assert.rejects(symlink("Welcome.txt", join(mount, "Documents/link.txt")));
    assert.equal(await readFile(join(mount, "Documents/Welcome.txt"), "utf8"), "desktop atomic save\n");

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
