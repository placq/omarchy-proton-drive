import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeDriveProvider } from "../src/fake-provider.ts";
import { StateStore } from "../src/state-store.ts";
import { LocalStorage } from "../src/local-storage.ts";
import { DriveEngine } from "../src/engine.ts";
import { OfflineError, UnsafeEvictionError, UnsafeMutationError } from "../src/domain.ts";
import { RpcServer } from "../src/rpc-server.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omarchy-drive-test-"));
  const provider = new FakeDriveProvider();
  const engine = new DriveEngine(provider, new StateStore(join(root, "state/state.sqlite")), new LocalStorage(join(root, "cache"), join(root, "state")));
  await engine.initialize(); return { root, provider, engine };
}

async function waitForStatus(engine: DriveEngine, nodeId: string, status: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (engine.getState(nodeId)?.status === status) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for status ${status}, got ${engine.getState(nodeId)?.status}`);
}

test("browse, materialize and cached open", async () => {
  const { provider, engine } = await fixture();
  const children = await engine.listChildren("docs"); assert.equal(children[0]?.name, "Welcome.txt");
  const path = await engine.materialize("welcome"); assert.match(await readFile(path, "utf8"), /fake provider/);
  provider.setOnline(false); assert.equal(await engine.materialize("welcome"), path);
});

test("an unpinned remote update invalidates stale cached bytes", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs");
  const oldPath = await engine.materialize("welcome");
  assert.match(await readFile(oldPath, "utf8"), /fake provider/);
  provider.remoteEdit("welcome", new TextEncoder().encode("new remote bytes"));
  await engine.processEvents();
  assert.equal(engine.getState("welcome")?.status, "cloud-only");
  assert.equal(engine.getState("welcome")?.cachePath, undefined);
  assert.equal(await readFile(await engine.materialize("welcome"), "utf8"), "new remote bytes");
});

test("a download binds cache to a newer provider revision than stale listing metadata", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs");
  await engine.materialize("welcome"); await engine.evict("welcome");
  provider.remoteEdit("welcome", new TextEncoder().encode("changed after listing"));
  const path = await engine.materialize("welcome");
  assert.equal(await readFile(path, "utf8"), "changed after listing");
  assert.equal(engine.getState("welcome")?.remoteRevision, "2");
  assert.equal(engine.getState("welcome")?.cacheRevision, "2");
});

test("a fresh folder listing avoids a redundant node lookup before download", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("root"); await engine.listChildren("docs");
  let lookups = 0; const original = provider.getNode.bind(provider);
  provider.getNode = async nodeId => { lookups += 1; return original(nodeId); };
  await engine.materialize("welcome"); assert.equal(lookups, 0);
});

test("new files are immediately backed by the local cache", async () => {
  const { provider, engine } = await fixture();
  const created = await engine.createFile("docs", "instant.txt", new TextEncoder().encode("instant"));
  const state = engine.getState(created.id); assert.equal(state?.status, "cached"); assert.ok(state?.cachePath);
  provider.setOnline(false);
  assert.equal(await readFile(await engine.materialize(created.id), "utf8"), "instant");
});

test("remembered root returns immediately while provider refresh runs in background", async () => {
  const { provider, engine } = await fixture(); await engine.root();
  let started!: () => void; const refreshStarted = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const original = provider.getRoot.bind(provider);
  provider.getRoot = async () => { started(); await gate; return original(); };
  const cached = await Promise.race([engine.root(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cached root blocked")), 100))]);
  assert.equal(cached.parentId, null); await refreshStarted; release();
});

test("offline cloud-only file returns an actionable failure", async () => {
  const { provider, engine } = await fixture(); provider.addFile("docs", "Online.txt", new TextEncoder().encode("online"), "online");
  await engine.listChildren("docs"); provider.setOnline(false);
  await assert.rejects(engine.materialize("online"), OfflineError);
});

test("pin survives state reload and eviction unpins", async () => {
  const { engine } = await fixture(); await engine.listChildren("docs");
  const pinned = await engine.pin("welcome", true); assert.equal(pinned.status, "pinned"); assert.ok(pinned.cachePath);
  const evicted = await engine.evict("welcome"); assert.equal(evicted.status, "cloud-only"); assert.equal(evicted.pinned, false);
});

test("startup removes orphaned and unverifiable cache files", async () => {
  const { root, provider, engine } = await fixture(); await engine.listChildren("docs");
  const cachedPath = await engine.materialize("welcome");
  const state = engine.getState("welcome")!;
  state.cacheRevision = undefined;
  engine.store.setState(state); await engine.store.save();
  const orphanPath = join(root, "cache/content/.orphan-download"); await writeFile(orphanPath, "orphan");
  const restarted = new DriveEngine(provider, new StateStore(join(root, "state/state.sqlite")), new LocalStorage(join(root, "cache"), join(root, "state")));
  await restarted.initialize();
  assert.equal(restarted.getState("welcome")?.status, "cloud-only");
  await assert.rejects(stat(cachedPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(stat(orphanPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("edit uploads a new revision without dropping staging early", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.materialize("welcome");
  await engine.stageBytes("welcome", new TextEncoder().encode("changed")); assert.equal(engine.getState("welcome")?.status, "dirty");
  const committed = await engine.commit("welcome"); assert.equal(committed.status, "cached"); assert.equal(committed.stagingPath, undefined);
  assert.equal(new TextDecoder().decode(await provider.readBytes("welcome")), "changed");
});

test("network loss queues staged data and retry commits it", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.materialize("welcome");
  await engine.stageBytes("welcome", new TextEncoder().encode("queued")); provider.setOnline(false);
  const queued = await engine.commit("welcome"); assert.equal(queued.status, "queued"); assert.ok(queued.stagingPath);
  provider.setOnline(true); await engine.syncQueued(); assert.equal(engine.getState("welcome")?.status, "cached");
});

test("remote edit creates conflict and preserves local bytes", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs");
  const maxByteName = `${"ą".repeat(127)}a`; assert.equal(Buffer.byteLength(maxByteName), 255);
  await engine.rename("welcome", maxByteName); await engine.materialize("welcome");
  await engine.stageBytes("welcome", new TextEncoder().encode("local edit")); provider.remoteEdit("welcome", new TextEncoder().encode("remote edit"));
  const conflict = await engine.commit("welcome"); assert.equal(conflict.status, "conflict"); assert.ok(conflict.stagingPath);
  assert.equal(new TextDecoder().decode(await engine.storage.read(conflict.stagingPath!)), "local edit");
  const preservedPath = conflict.error?.replace("Both versions preserved; local copy: ", ""); assert.ok(preservedPath);
  assert.ok(Buffer.byteLength(preservedPath!.split("/").at(-1)!, "utf8") <= 255);
  assert.equal(new TextDecoder().decode(await engine.storage.read(preservedPath!)), "local edit");
  await assert.rejects(engine.evict("welcome"), UnsafeEvictionError);
  assert.equal(new TextDecoder().decode(await provider.readBytes("welcome")), "remote edit");
  await engine.resolveConflict("welcome", "save-both");
  const copy = (await provider.listChildren("docs")).find(node => node.id !== "welcome"); assert.ok(copy);
  assert.ok(Buffer.byteLength(copy!.name, "utf8") <= 255);
  assert.equal(new TextDecoder().decode(await provider.readBytes(copy!.id)), "local edit");
});

test("conflicts can keep local, keep remote or save both versions", async () => {
  for (const resolution of ["keep-local", "keep-remote", "save-both"] as const) {
    const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.materialize("welcome");
    await engine.stageBytes("welcome", new TextEncoder().encode("local")); provider.remoteEdit("welcome", new TextEncoder().encode("remote"));
    assert.equal((await engine.commit("welcome")).status, "conflict");
    const resolved = await engine.resolveConflict("welcome", resolution, resolution === "save-both" ? "local copy.txt" : undefined);
    assert.notEqual(resolved.status, "conflict");
    if (resolution === "keep-local") assert.equal(new TextDecoder().decode(await provider.readBytes("welcome")), "local");
    if (resolution === "keep-remote") assert.equal(new TextDecoder().decode(await provider.readBytes("welcome")), "remote");
    if (resolution === "save-both") {
      const copy = (await provider.listChildren("docs")).find(node => node.name === "local copy.txt"); assert.ok(copy);
      assert.equal(new TextDecoder().decode(await provider.readBytes(copy!.id)), "local");
      assert.equal(new TextDecoder().decode(await provider.readBytes("welcome")), "remote");
    }
  }
});

test("failed conflict finalisation never deletes persistent staging", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.materialize("welcome");
  await engine.stageBytes("welcome", new TextEncoder().encode("local")); provider.remoteEdit("welcome", new TextEncoder().encode("remote"));
  assert.equal((await engine.commit("welcome")).status, "conflict");
  const stagingPath = engine.getState("welcome")!.stagingPath!;
  provider.getNode = async () => { throw new OfflineError(); };
  await assert.rejects(engine.resolveConflict("welcome", "keep-remote"), OfflineError);
  assert.equal(engine.getState("welcome")?.status, "conflict");
  assert.equal(new TextDecoder().decode(await engine.storage.read(stagingPath)), "local");
});

test("remote deletion preserves staged bytes through every conflict resolution", async () => {
  for (const resolution of ["keep-local", "keep-remote", "save-both"] as const) {
    const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.materialize("welcome");
    await engine.stageBytes("welcome", new TextEncoder().encode(`local after delete: ${resolution}`));
    await provider.trash("welcome"); await engine.processEvents();
    const conflict = engine.getState("welcome")!;
    assert.equal(conflict.status, "conflict"); assert.equal(conflict.remoteDeleted, true); assert.ok(conflict.stagingPath);
    assert.equal(new TextDecoder().decode(await engine.storage.read(conflict.stagingPath)), `local after delete: ${resolution}`);
    await engine.resolveConflict("welcome", resolution, resolution === "save-both" ? "Recovered.txt" : undefined);
    assert.equal(engine.getState("welcome"), undefined);
    const children = await provider.listChildren("docs");
    if (resolution === "keep-remote") assert.deepEqual(children, []);
    else {
      const restored = children.find(child => child.name === (resolution === "save-both" ? "Recovered.txt" : "Welcome.txt")); assert.ok(restored);
      assert.equal(new TextDecoder().decode(await provider.readBytes(restored!.id)), `local after delete: ${resolution}`);
    }
  }
  const nested = await fixture(); await nested.engine.listChildren("root"); await nested.engine.listChildren("docs"); await nested.engine.pin("docs", true);
  await nested.engine.stageBytes("welcome", new TextEncoder().encode("survive deleted folder"));
  await nested.provider.trash("docs"); nested.provider.emitTreeRemoval(); await nested.engine.processEvents();
  assert.equal(nested.engine.getState("welcome")?.status, "conflict");
  assert.equal(nested.engine.getState("docs")?.remoteDeleted, true);
  assert.equal(new TextDecoder().decode(await nested.engine.storage.read(nested.engine.getState("welcome")!.stagingPath!)), "survive deleted folder");
  await assert.rejects(nested.engine.trash("docs"), UnsafeMutationError);
  await nested.engine.resolveConflict("welcome", "keep-local");
  const restoredFolder = (await nested.provider.listChildren("root")).find(node => node.name === "Documents"); assert.ok(restoredFolder);
  const restoredFile = (await nested.provider.listChildren(restoredFolder!.id)).find(node => node.name === "Welcome.txt"); assert.ok(restoredFile);
  assert.equal(new TextDecoder().decode(await nested.provider.readBytes(restoredFile!.id)), "survive deleted folder");

  const acceptDeletedTree = await fixture(); await acceptDeletedTree.engine.listChildren("root"); await acceptDeletedTree.engine.listChildren("docs");
  await acceptDeletedTree.engine.stageBytes("welcome", new TextEncoder().encode("discard only when explicitly accepted"));
  await acceptDeletedTree.provider.trash("docs"); await acceptDeletedTree.engine.processEvents();
  await acceptDeletedTree.engine.resolveConflict("welcome", "keep-remote");
  assert.equal(acceptDeletedTree.engine.store.getNode("docs"), undefined);
  assert.equal(acceptDeletedTree.engine.store.getNode("welcome"), undefined);

  const clean = await fixture(); await clean.engine.listChildren("root"); await clean.engine.listChildren("docs");
  await clean.provider.trash("docs"); await clean.engine.processEvents();
  assert.equal(clean.engine.store.getNode("docs"), undefined); assert.equal(clean.engine.store.getNode("welcome"), undefined);
});

test("pinning a folder recursively pins nested files", async () => {
  const { provider, engine } = await fixture(); provider.addFolder("docs", "Nested", "nested"); provider.addFile("nested", "deep.txt", new TextEncoder().encode("deep"), "deep");
  await engine.pin("docs", true);
  assert.equal(engine.getState("welcome")?.status, "pinned");
  assert.equal(engine.getState("deep")?.status, "pinned");
  await engine.pin("docs", false);
  assert.equal(engine.getState("deep")?.pinned, false);
});

test("recursive pinning reuses listed metadata instead of looking up every node", async () => {
  const { provider, engine } = await fixture(); provider.addFolder("docs", "Nested", "nested"); provider.addFile("nested", "deep.txt", new TextEncoder().encode("deep"), "deep");
  await engine.listChildren("root"); await engine.listChildren("docs"); await engine.listChildren("nested");
  let lookups = 0; const original = provider.getNode.bind(provider);
  provider.getNode = async nodeId => { lookups += 1; return original(nodeId); };
  await engine.pin("docs", true); assert.equal(lookups, 0);
});

test("dirty local data cannot be trashed", async () => {
  const { engine } = await fixture(); await engine.listChildren("docs"); await engine.stageBytes("welcome", new Uint8Array([1]));
  await assert.rejects(engine.trash("welcome"), UnsafeMutationError);
});

test("trashing a clean node removes its local cache bytes", async () => {
  const { engine } = await fixture(); await engine.listChildren("docs");
  const cachePath = await engine.materialize("welcome");
  assert.ok((await stat(cachePath)).isFile());
  await engine.trash("welcome");
  await assert.rejects(stat(cachePath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.equal(await engine.cacheUsage(), 0);
});

test("folder mutations refuse unsynchronised descendants", async () => {
  const { provider, engine } = await fixture();
  await engine.listChildren("root"); await engine.listChildren("docs");
  await engine.stageBytes("welcome", new TextEncoder().encode("must survive"));
  await assert.rejects(engine.trash("docs"), UnsafeMutationError);
  await assert.rejects(engine.rename("docs", "Renamed"), UnsafeMutationError);
  await assert.rejects(engine.move("docs", "root"), UnsafeMutationError);
  assert.equal((await provider.getNode("docs")).name, "Documents");
  assert.equal(new TextDecoder().decode(await engine.storage.read(engine.getState("welcome")!.stagingPath!)), "must survive");
});

test("an error state with staging still blocks destructive mutations", async () => {
  const { engine } = await fixture(); await engine.listChildren("docs");
  await engine.stageBytes("welcome", new TextEncoder().encode("recoverable"));
  const state = engine.getState("welcome")!; state.status = "error"; engine.store.setState(state); await engine.store.save();
  await assert.rejects(engine.trash("welcome"), UnsafeMutationError);
});

test("LRU limit only evicts clean unpinned cache", async () => {
  const { provider, engine } = await fixture(); provider.addFile("docs", "a", new Uint8Array(10), "a"); provider.addFile("docs", "b", new Uint8Array(10), "b");
  await engine.listChildren("docs"); await engine.materialize("a"); await engine.materialize("b"); await engine.pin("b", true);
  const remaining = await engine.enforceCacheLimit(10); assert.equal(remaining, 10); assert.equal(engine.getState("a")?.status, "cloud-only"); assert.equal(engine.getState("b")?.status, "pinned");
});

test("cache eviction is local and never waits for a provider metadata request", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.materialize("welcome");
  provider.getNode = async () => { throw new Error("unexpected provider lookup"); };
  const state = await engine.evict("welcome"); assert.equal(state.status, "cloud-only"); assert.equal(state.cachePath, undefined);
});

test("cache clear reports bytes deliberately retained for offline files", async () => {
  const { provider, engine } = await fixture(); provider.addFile("docs", "temporary.bin", new Uint8Array(10), "temporary");
  await engine.listChildren("docs"); await engine.materialize("temporary"); await engine.pin("welcome", true);
  const result = await engine.clearDisposableCache();
  assert.equal(result.freedBytes, 10); assert.equal(result.retainedPinnedFiles, 1); assert.ok(result.retainedPinnedBytes > 0);
});

test("pinned cache clear removes always-available copies but preserves unsafe local changes", async () => {
  const { provider, engine } = await fixture(); provider.addFile("docs", "safe.bin", new Uint8Array(10), "safe"); provider.addFile("docs", "dirty.bin", new Uint8Array(12), "dirty");
  await engine.listChildren("docs"); await engine.pin("safe", true); await engine.pin("dirty", true); await engine.stageBytes("dirty", new TextEncoder().encode("local edit"));
  const result = await engine.clearPinnedCache();
  assert.equal(result.clearedPinnedFiles, 1); assert.equal(result.retainedUnsafeFiles, 1); assert.equal(engine.getState("safe")?.status, "cloud-only"); assert.equal(engine.getState("safe")?.pinned, false);
  assert.equal(engine.getState("dirty")?.status, "dirty"); assert.equal(engine.getState("dirty")?.pinned, true); assert.ok(engine.getState("dirty")?.stagingPath);
});

test("atomic state file is valid after repeated writes", async () => {
  const { root, engine } = await fixture(); await engine.listChildren("docs"); await engine.pin("welcome", true); await engine.pin("welcome", false);
  const reopened = new StateStore(join(root, "state/state.sqlite")); await reopened.load();
  assert.equal(reopened.getNode("welcome")?.name, "Welcome.txt");
  assert.equal(reopened.getState("welcome")?.pinned, false);
});

test("incremental SQLite writes preserve unrelated nodes and persist deletions", async () => {
  const { root, engine } = await fixture(); await engine.listChildren("docs");
  engine.store.setNode({ id: "extra", parentId: "docs", name: "extra.txt", kind: "file", size: 1, modifiedAt: 1, revision: "1" });
  await engine.store.save(); engine.store.deleteNode("welcome"); await engine.store.save();
  const reopened = new StateStore(join(root, "state/state.sqlite")); await reopened.load();
  assert.equal(reopened.getNode("extra")?.name, "extra.txt"); assert.equal(reopened.getNode("welcome"), undefined);
  assert.equal(reopened.findChild("docs", "extra.txt")?.id, "extra");
});

test("legacy JSON state migrates atomically into SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-drive-migration-"));
  const legacy = join(root, "state.json"); const sqlite = join(root, "state.sqlite");
  await writeFile(legacy, JSON.stringify({ version: 1, nodes: { root: { id:"root", parentId:null, name:"Proton Drive", kind:"folder", size:0, modifiedAt:1, revision:"1" } }, states: {}, lastEventId:"42" }));
  const store = new StateStore(sqlite, legacy); await store.load();
  assert.equal(store.getNode("root")?.name, "Proton Drive"); assert.equal(store.getLastEventId(), "42");
  const reopened = new StateStore(sqlite, legacy); await reopened.load(); assert.equal(reopened.getLastEventId(), "42");
});

test("SQLite state and journals remain private and corruption is never silently reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-drive-sqlite-"));
  const sqlite = join(root, "state.sqlite"); const store = new StateStore(sqlite); await store.load();
  store.setNode({ id:"root", parentId:null, name:"Proton Drive", kind:"folder", size:0, modifiedAt:1, revision:"1" }); await store.save();
  for (const path of [sqlite, `${sqlite}-wal`, `${sqlite}-shm`]) assert.equal((await stat(path)).mode & 0o777, 0o600);
  const corrupt = join(root, "corrupt.sqlite"); await writeFile(corrupt, "not a sqlite database", { mode: 0o600 });
  await assert.rejects(new StateStore(corrupt).load(), /database|encrypted/i);
});

test("a failed SQLite transaction is retried without losing pending state", async () => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-drive-sqlite-retry-"));
  const sqlite = join(root, "state.sqlite"); const store = new StateStore(sqlite); await store.load();
  store.setNode({ id:"root", parentId:null, name:"Proton Drive", kind:"folder", size:0, modifiedAt:1, revision:"1" });
  store.setState({ nodeId:"root", status:"queued", pinned:false, remoteRevision:"1", stagingPath:join(root, "precious.stage"), lastAccessedAt:1 });
  store.setLastEventId("event-1");
  const database = (store as unknown as { database: { exec(sql: string): unknown } }).database;
  const originalExec = database.exec.bind(database); let failCommit = true;
  database.exec = (sql: string) => {
    if (sql === "COMMIT" && failCommit) { failCommit = false; throw new Error("simulated commit failure"); }
    return originalExec(sql);
  };
  await assert.rejects(store.save(), /simulated commit failure/);
  await store.save();
  const reopened = new StateStore(sqlite); await reopened.load();
  assert.equal(reopened.getState("root")?.status, "queued");
  assert.equal(reopened.getState("root")?.stagingPath, join(root, "precious.stage"));
  assert.equal(reopened.getLastEventId(), "event-1");
});

test("pinned file refreshes from Drive events", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.pin("welcome", true);
  provider.remoteEdit("welcome", new TextEncoder().encode("fresh remote")); await engine.processEvents();
  const state=engine.getState("welcome"); assert.equal(state?.status, "pinned"); assert.equal(new TextDecoder().decode(await engine.storage.read(state!.cachePath!)), "fresh remote");
});

test("tree removal refresh marker never becomes the persisted event cursor", async () => {
  const { provider, engine } = await fixture();
  provider.remoteEdit("welcome", new TextEncoder().encode("refresh me"));
  provider.emitTreeRemoval();
  await engine.processEvents();
  assert.equal(engine.store.getLastEventId(), "1");
});

test("refresh markers update pinned folders without recursively polling every known subtree", async () => {
  const { provider, engine } = await fixture();
  await engine.listChildren("root");
  await engine.listChildren("docs");
  await engine.pin("docs", true);
  provider.addFolder("docs", "Nested", "nested");
  provider.addFile("nested", "fresh.txt", new TextEncoder().encode("fresh"), "fresh");
  provider.emitTreeRemoval();
  await engine.processEvents();
  assert.equal(engine.store.getNode("nested")?.name, "Nested");
  assert.equal(engine.store.getNode("fresh"), undefined);
  assert.equal((await engine.listChildren("nested"))[0]?.name, "fresh.txt");
});

test("unicode, zero byte, mkdir, rename, move and trash use native provider operations", async () => {
  const { engine } = await fixture(); const folder=await engine.createFolder("root", "Zażółć 🛰️");
  const file=await engine.createFile("root", "zero byte.txt", new Uint8Array()); assert.equal(file.size, 0);
  const renamed=await engine.rename(file.id, "renamed.txt"); assert.equal(renamed.name, "renamed.txt");
  const moved=await engine.move(file.id, folder.id); assert.equal(moved.parentId, folder.id);
  const transferChanges: Array<{direction:string, state:string}> = [];
  engine.transfers.on("changed", transfer => transferChanges.push(transfer));
  await engine.trash(file.id);
  assert.deepEqual(transferChanges.map(change => [change.direction, change.state]), [["trash", "running"], ["trash", "complete"]]);
  assert.equal((await engine.listChildren(folder.id)).length, 0);
});

test("atomic file replacement preserves bytes, pin intent and rollback safety", async () => {
  const success = await fixture(); await success.engine.listChildren("docs"); await success.engine.pin("welcome", true);
  const temporary = await success.engine.createFile("docs", ".editor-save.tmp", new TextEncoder().encode("atomic replacement"));
  const replaced = await success.engine.replace(temporary.id, "welcome");
  assert.equal(replaced.id, temporary.id); assert.equal(replaced.name, "Welcome.txt");
  assert.equal(success.engine.getState(replaced.id)?.status, "pinned"); assert.equal(success.engine.store.getNode("welcome"), undefined);
  assert.equal(new TextDecoder().decode(await success.provider.readBytes(replaced.id)), "atomic replacement");
  assert.deepEqual((await success.provider.listChildren("docs")).map(node => node.name), ["Welcome.txt"]);

  const rollback = await fixture(); await rollback.engine.listChildren("docs");
  const rollbackSource = await rollback.engine.createFile("docs", ".rollback.tmp", new TextEncoder().encode("new bytes"));
  const originalRename = rollback.provider.rename.bind(rollback.provider);
  rollback.provider.rename = async (nodeId, name) => {
    if (nodeId === rollbackSource.id) throw new OfflineError("simulated source rename failure");
    return originalRename(nodeId, name);
  };
  await assert.rejects(rollback.engine.replace(rollbackSource.id, "welcome"), OfflineError);
  const afterRollback = await rollback.provider.listChildren("docs");
  assert.ok(afterRollback.some(node => node.id === "welcome" && node.name === "Welcome.txt"));
  assert.ok(afterRollback.some(node => node.id === rollbackSource.id && node.name === ".rollback.tmp"));
  assert.match(new TextDecoder().decode(await rollback.provider.readBytes("welcome")), /fake provider/);
  assert.equal(new TextDecoder().decode(await rollback.provider.readBytes(rollbackSource.id)), "new bytes");

  const crossFolder = await fixture(); await crossFolder.engine.listChildren("root"); await crossFolder.engine.listChildren("docs");
  const crossSource = await crossFolder.engine.createFile("root", ".cross-folder.tmp", new TextEncoder().encode("cross-folder bytes"));
  const crossRename = crossFolder.provider.rename.bind(crossFolder.provider);
  crossFolder.provider.rename = async (nodeId, name) => {
    if (nodeId === crossSource.id) throw new OfflineError("simulated cross-folder rename failure");
    return crossRename(nodeId, name);
  };
  await assert.rejects(crossFolder.engine.replace(crossSource.id, "welcome"), OfflineError);
  assert.ok((await crossFolder.provider.listChildren("root")).some(node => node.id === crossSource.id && node.name === ".cross-folder.tmp"));
  assert.ok((await crossFolder.provider.listChildren("docs")).some(node => node.id === "welcome" && node.name === "Welcome.txt"));
  assert.equal(new TextDecoder().decode(await crossFolder.provider.readBytes(crossSource.id)), "cross-folder bytes");
});

test("folders cannot be moved into their own descendants", async () => {
  const { engine } = await fixture(); await engine.listChildren("root"); await engine.listChildren("docs");
  const nested = await engine.createFolder("docs", "Nested");
  await assert.rejects(engine.move("docs", nested.id), /into itself or its descendant/);
});

test("RPC dispatcher exposes versioned status and core actions", async () => {
  const { engine } = await fixture(); const rpc=new RpcServer(engine, "/unused");
  const dispatch=(rpc as unknown as { dispatch(method:string, params:Record<string,unknown>):Promise<unknown> }).dispatch.bind(rpc);
  const version=await dispatch("GetVersion", {}) as {apiVersion:number}; assert.equal(version.apiVersion, 1);
  const root=await dispatch("GetRoot", {}) as {id:string}; assert.equal(root.id, "root");
  const children=await dispatch("ListChildren", {nodeId:"docs"}) as unknown[]; assert.equal(children.length, 1);
});

test("RPC rejects path-like identifiers and unsafe names", async () => {
  const { engine } = await fixture(); const rpc = new RpcServer(engine, "/unused");
  const dispatch = (rpc as unknown as { dispatch(method: string, params: Record<string, unknown>): Promise<unknown> }).dispatch.bind(rpc);
  await assert.rejects(dispatch("GetNode", { nodeId: "../state" }), /Invalid nodeId/);
  await assert.rejects(dispatch("GetNode", { nodeId: "abc==~def==" }), /Node not found/);
  await assert.rejects(dispatch("Rename", { nodeId: "welcome", name: "../state" }), /Invalid node name/);
  await assert.rejects(dispatch("CreateFolder", { parentId: "root", name: "" }), /Invalid node name/);
  await assert.rejects(dispatch("CreateFolder", { parentId: "root", name: "ą".repeat(128) }), /Invalid node name/);
  await assert.rejects(dispatch("CreateFolder", { parentId: "root", name: "bad\uD800name" }), /Invalid node name/);
  const normalized = await dispatch("Rename", { nodeId: "welcome", name: "e\u0301.txt" }) as {name:string};
  assert.equal(normalized.name, "é.txt");
});

test("an RPC timeout cancels a queued remote mutation", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs");
  const original = provider.rename.bind(provider); let mutated = false;
  provider.rename = async (nodeId, name, knownNode, signal) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 100);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    mutated = true;
    return original(nodeId, name, knownNode, signal);
  };
  const rpc = new RpcServer(engine, "/unused", 20);
  const bounded = (rpc as unknown as { boundedDispatch(method: string, params: Record<string, unknown>): Promise<unknown> }).boundedDispatch.bind(rpc);
  await assert.rejects(bounded("Rename", { nodeId: "welcome", name: "too-late.txt" }), { name: "TimeoutError" });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(mutated, false);
  assert.equal((await provider.getNode("welcome")).name, "Welcome.txt");
});

test("local storage maps long Proton UIDs to safe stable filenames", async () => {
  const root = await mkdtemp(join(tmpdir(), "omarchy-drive-uid-"));
  const storage = new LocalStorage(join(root, "cache"), join(root, "state"));
  const uid = `${"A".repeat(180)}==~${"B".repeat(180)}==`;
  const first = storage.cachePath(uid);
  assert.equal(first, storage.cachePath(uid));
  assert.match(first, /\/uid-[a-f0-9]{64}$/);
  const equalA = join(root, "equal-a"); const equalB = join(root, "equal-b"); const different = join(root, "different");
  await writeFile(equalA, Buffer.alloc(70_001, 0x5a)); await writeFile(equalB, Buffer.alloc(70_001, 0x5a)); await writeFile(different, Buffer.alloc(70_001, 0x5b));
  assert.equal(await storage.sameBytes(equalA, equalB), true); assert.equal(await storage.sameBytes(equalA, different), false);
  await rm(root, { recursive: true, force: true });
});

test("daemon restart recovers interrupted upload from persistent staging", async () => {
  const { root, provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.stageBytes("welcome", new TextEncoder().encode("survives crash"));
  const interrupted=engine.getState("welcome")!; interrupted.status="uploading"; engine.store.setState(interrupted); await engine.store.save();
  const restarted=new DriveEngine(provider, new StateStore(join(root, "state/state.sqlite")), new LocalStorage(join(root, "cache"), join(root, "state"))); await restarted.initialize();
  assert.equal(restarted.getState("welcome")?.status, "queued"); assert.ok(restarted.getState("welcome")?.stagingPath);
  await restarted.syncQueued(); assert.equal(new TextDecoder().decode(await provider.readBytes("welcome")), "survives crash");
});

test("restart recognizes an upload committed remotely before local state was saved", async () => {
  const { root, provider, engine } = await fixture(); await engine.listChildren("docs");
  const bytes = new TextEncoder().encode("remote commit won the crash race");
  await engine.stageBytes("welcome", bytes);
  const interrupted = engine.getState("welcome")!; interrupted.status = "uploading"; engine.store.setState(interrupted); await engine.store.save();
  provider.remoteEdit("welcome", bytes);
  const restarted = new DriveEngine(provider, new StateStore(join(root, "state/state.sqlite")), new LocalStorage(join(root, "cache"), join(root, "state")));
  await restarted.initialize();
  assert.equal(restarted.getState("welcome")?.interruptedUpload, true);
  const recovered = await restarted.syncQueued();
  assert.equal(recovered, undefined);
  assert.equal(restarted.getState("welcome")?.status, "cached");
  assert.equal(restarted.getState("welcome")?.stagingPath, undefined);
  assert.equal(new TextDecoder().decode(await provider.readBytes("welcome")), "remote commit won the crash race");
});

test("restart keeps same-size divergent remote bytes as a recoverable conflict", async () => {
  const { root, provider, engine } = await fixture(); await engine.listChildren("docs");
  const local = new TextEncoder().encode("local bytes"); const remote = new TextEncoder().encode("other bytes");
  assert.equal(local.byteLength, remote.byteLength);
  await engine.stageBytes("welcome", local);
  const interrupted = engine.getState("welcome")!; interrupted.status = "uploading"; engine.store.setState(interrupted); await engine.store.save();
  provider.remoteEdit("welcome", remote);
  const restarted = new DriveEngine(provider, new StateStore(join(root, "state/state.sqlite")), new LocalStorage(join(root, "cache"), join(root, "state")));
  await restarted.initialize(); await restarted.syncQueued();
  const conflict = restarted.getState("welcome")!;
  assert.equal(conflict.status, "conflict"); assert.ok(conflict.stagingPath);
  assert.equal(new TextDecoder().decode(await restarted.storage.read(conflict.stagingPath)), "local bytes");
  assert.equal(new TextDecoder().decode(await provider.readBytes("welcome")), "other bytes");
});

test("failed local finalisation after a remote commit retains staging and self-recovers", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs");
  await engine.stageBytes("welcome", new TextEncoder().encode("remote safe, local save failed"));
  const originalSave = engine.store.save.bind(engine.store); let saves = 0;
  engine.store.save = async () => {
    saves += 1;
    if (saves === 2) throw new Error("simulated final state failure");
    return originalSave();
  };
  const pending = await engine.commit("welcome");
  assert.equal(pending.status, "queued"); assert.equal(pending.interruptedUpload, true); assert.ok(pending.stagingPath);
  assert.equal(new TextDecoder().decode(await engine.storage.read(pending.stagingPath!)), "remote safe, local save failed");
  assert.equal(new TextDecoder().decode(await provider.readBytes("welcome")), "remote safe, local save failed");
  const recovered = await engine.commit("welcome");
  assert.equal(recovered.status, "cached"); assert.equal(recovered.stagingPath, undefined);
  assert.equal(new TextDecoder().decode(await provider.readBytes("welcome")), "remote safe, local save failed");
});

test("restart removes leftover staging only after committed state was durable", async () => {
  const { root, provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.materialize("welcome");
  const stagingPath = await engine.beginWrite("welcome");
  const committed = engine.getState("welcome")!; committed.status = "cached"; committed.baseRevision = undefined;
  engine.store.setState(committed); await engine.store.save();
  assert.equal(await engine.storage.exists(stagingPath), true);
  const restarted = new DriveEngine(provider, new StateStore(join(root, "state/state.sqlite")), new LocalStorage(join(root, "cache"), join(root, "state")));
  await restarted.initialize();
  assert.equal(restarted.getState("welcome")?.status, "cached"); assert.equal(restarted.getState("welcome")?.stagingPath, undefined);
  assert.equal(await restarted.storage.exists(stagingPath), false);
});

test("large upload is committed from a file path without engine buffering", async () => {
  const { root, provider, engine } = await fixture(); await engine.listChildren("docs");
  const large=join(root, "large.bin"); await writeFile(large, Buffer.alloc(16 * 1024 * 1024, 0x5a)); await engine.stageFile("welcome", large);
  engine.storage.read=async () => { throw new Error("engine attempted to buffer file"); };
  const state=await engine.commit("welcome"); assert.equal(state.status, "cached"); assert.equal((await provider.readBytes("welcome")).byteLength, 16 * 1024 * 1024);
});

test("filesystem commit is persisted as queued before background upload", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.stageBytes("welcome", new TextEncoder().encode("background"));
  let releaseUpload!: () => void; const gate=new Promise<void>(resolve => { releaseUpload=resolve; });
  let uploadStarted!: () => void; const started=new Promise<void>(resolve => { uploadStarted=resolve; });
  const original=provider.upload.bind(provider); provider.upload=async input => { uploadStarted(); await gate; return original(input); };
  const queued=await engine.queueCommit("welcome"); assert.equal(queued.status, "queued"); assert.equal(engine.getState("welcome")?.status, "queued");
  assert.equal(engine.store.getNode("welcome")?.size, "background".length);
  await started; assert.equal(engine.getState("welcome")?.status, "uploading");
  assert.equal(await readFile(await engine.materialize("welcome"), "utf8"), "background");
  releaseUpload(); await engine.commit("welcome"); assert.equal(engine.getState("welcome")?.status, "cached");
});

test("background commit setup failure stays queued with exact staging bytes", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs");
  await engine.stageBytes("welcome", new TextEncoder().encode("survive setup failure"));
  const originalSize = engine.storage.size.bind(engine.storage); let sizeCalls = 0;
  engine.storage.size = async path => {
    sizeCalls += 1;
    if (sizeCalls === 2) throw new Error("simulated storage failure");
    return originalSize(path);
  };
  await engine.queueCommit("welcome");
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const queued = engine.getState("welcome")!;
  assert.equal(queued.status, "queued"); assert.ok(queued.stagingPath);
  assert.equal(new TextDecoder().decode(await engine.storage.read(queued.stagingPath)), "survive setup failure");
  assert.notEqual(new TextDecoder().decode(await provider.readBytes("welcome")), "survive setup failure");
  engine.storage.size = originalSize;
  assert.equal((await engine.commit("welcome")).status, "cached");
  assert.equal(new TextDecoder().decode(await provider.readBytes("welcome")), "survive setup failure");
});

test("cancelling a queued upload reverts to dirty and keeps staged bytes", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.stageBytes("welcome", new TextEncoder().encode("precious bytes"));
  let uploadCalled=false; const original=provider.upload.bind(provider); provider.upload=async input => { uploadCalled=true; return original(input); };
  await engine.queueCommit("welcome");
  const transfer=engine.transfers.list().find(t => t.nodeId === "welcome" && t.direction === "upload"); assert.ok(transfer); assert.equal(transfer.state, "queued");
  await engine.cancelQueuedUpload(transfer.id);
  await waitForStatus(engine, "welcome", "dirty");
  const state=engine.getState("welcome")!; assert.ok(state.stagingPath); assert.equal(new TextDecoder().decode(await engine.storage.read(state.stagingPath)), "precious bytes");
  assert.equal(uploadCalled, false);
  const committed=await engine.commit("welcome"); assert.equal(committed.status, "cached");
  assert.equal(new TextDecoder().decode(await provider.readBytes("welcome")), "precious bytes");
});

test("cancelling a running upload aborts the provider and preserves staging", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.stageBytes("welcome", new TextEncoder().encode("abort me"));
  let releaseUpload!: () => void; const gate=new Promise<void>(resolve => { releaseUpload=resolve; });
  let uploadStarted!: () => void; const started=new Promise<void>(resolve => { uploadStarted=resolve; });
  let sawSignal: AbortSignal | undefined; const original=provider.upload.bind(provider);
  provider.upload=async input => { uploadStarted(); sawSignal=input.signal; await gate; if (input.signal?.aborted) throw new Error("Upload cancelled"); return original(input); };
  await engine.queueCommit("welcome"); await started; assert.equal(engine.getState("welcome")?.status, "uploading");
  const transfer=engine.transfers.list().find(t => t.nodeId === "welcome" && t.direction === "upload"); assert.ok(transfer); assert.equal(transfer.state, "running");
  const cancelled=await engine.cancelQueuedUpload(transfer.id); assert.equal(cancelled.status, "uploading");
  assert.ok(sawSignal); assert.equal(sawSignal!.aborted, true);
  releaseUpload();
  await waitForStatus(engine, "welcome", "dirty");
  assert.equal(engine.getState("welcome")?.status, "dirty");
  assert.equal(engine.getState("welcome")?.error, "Upload cancelled");
  assert.ok(engine.getState("welcome")?.stagingPath); assert.equal(new TextDecoder().decode(await engine.storage.read(engine.getState("welcome")!.stagingPath!)), "abort me");
  assert.equal(engine.transfers.list().find(t => t.nodeId === "welcome")?.state, "cancelled");
});

test("cancel rejects unknown transfers and non-upload directions", async () => {
  const { engine } = await fixture();
  await assert.rejects(engine.cancelQueuedUpload("missing-transfer"), /Unknown transfer/);
  const transfer=engine.transfers.start("welcome", "download", "Welcome.txt", 100);
  await assert.rejects(engine.cancelQueuedUpload(transfer.id), /Only upload transfers can be cancelled/);
});

test("conflicts are reported with names and cleared after resolution", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.materialize("welcome");
  await engine.stageBytes("welcome", new TextEncoder().encode("local")); provider.remoteEdit("welcome", new TextEncoder().encode("remote"));
  assert.equal((await engine.commit("welcome")).status, "conflict");
  const conflicts=engine.conflicts();
  assert.equal(conflicts.length, 1);
  const conflict=conflicts[0]!;
  assert.equal(conflict.nodeId, "welcome");
  assert.equal(conflict.name, "Welcome.txt");
  assert.match(conflict.error ?? "", /^Both versions preserved; local copy: /);
  await engine.resolveConflict("welcome", "keep-remote");
  assert.deepEqual(engine.conflicts(), []);
});

test("providers without progress support expose indeterminate transfers", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.materialize("welcome");
  (provider as { progressSupported?: boolean }).progressSupported = false;
  await engine.stageBytes("welcome", new TextEncoder().encode("indeterminate")); await engine.commit("welcome");
  const upload=engine.transfers.list().find(t => t.nodeId === "welcome" && t.direction === "upload"); assert.equal(upload?.bytesTotal, 0);
  assert.equal(upload?.state, "complete");
  await engine.evict("welcome");
  await engine.materialize("welcome");
  const downloads=engine.transfers.list().filter(t => t.nodeId === "welcome" && t.direction === "download");
  assert.equal(downloads.at(-1)?.bytesTotal, 0);
});

test("maintenance retries offline uploads after connectivity returns", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.stageBytes("welcome", new TextEncoder().encode("automatic retry"));
  provider.setOnline(false); await engine.commit("welcome"); assert.equal(engine.getState("welcome")?.status, "queued");
  provider.setOnline(true); await engine.maintenanceCycle(20 * 1024 ** 3);
  assert.equal(engine.getState("welcome")?.status, "cached"); assert.equal(new TextDecoder().decode(await provider.readBytes("welcome")), "automatic retry");
});

test("concurrent materialization shares one download", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs");
  let downloads=0; const original=provider.downloadToPath.bind(provider); provider.downloadToPath=async (...args) => { downloads += 1; return original(...args); };
  const [first, second]=await Promise.all([engine.materialize("welcome"), engine.materialize("welcome")]);
  assert.equal(first, second); assert.equal(downloads, 1);
});

test("concurrent first-time folder listings share one provider request", async () => {
  const { provider, engine } = await fixture(); const folder = await engine.createFolder("root", "Slow folder");
  let calls = 0; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const original = provider.listChildren.bind(provider);
  provider.listChildren = async parentId => { if (parentId === folder.id) { calls += 1; await gate; } return original(parentId); };
  const first = engine.listChildren(folder.id); const second = engine.listChildren(folder.id);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  release(); assert.deepEqual(await first, []); assert.deepEqual(await second, []);
});

test("known folder listings return cached metadata while stale refresh runs in background", async () => {
  const { provider, engine } = await fixture(); const folder = await engine.createFolder("root", "Cached folder");
  provider.addFile(folder.id, "cached.txt", new TextEncoder().encode("cached"), "cached-child");
  assert.equal((await engine.listChildren(folder.id))[0]?.name, "cached.txt");
  const folderState = engine.getState(folder.id)!; folderState.childrenRefreshedAt = 0; engine.store.setState(folderState); await engine.store.save();
  let started!: () => void; const refreshStarted = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const original = provider.listChildren.bind(provider);
  provider.listChildren = async parentId => { if (parentId === folder.id) { started(); await gate; } return original(parentId); };
  const listing = engine.listChildren(folder.id);
  const cached = await Promise.race([listing, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cached listing blocked")), 100))]);
  assert.equal(cached[0]?.name, "cached.txt"); await refreshStarted; release();
});

test("reopening an offline queued edit reuses persistent staging", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.materialize("welcome");
  await engine.stageBytes("welcome", new TextEncoder().encode("first offline edit")); provider.setOnline(false); await engine.commit("welcome");
  const before=engine.getState("welcome")!.stagingPath; const reopened=await engine.beginWrite("welcome");
  assert.equal(reopened, before); assert.equal(new TextDecoder().decode(await engine.storage.read(reopened)), "first offline edit"); assert.equal(engine.getState("welcome")?.status, "dirty");
});
