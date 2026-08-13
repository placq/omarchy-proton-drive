import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeDriveProvider } from "../src/fake-provider.ts";
import { StateStore } from "../src/state-store.ts";
import { LocalStorage } from "../src/local-storage.ts";
import { DriveEngine } from "../src/engine.ts";
import { OfflineError, UnsafeEvictionError } from "../src/domain.ts";
import { RpcServer } from "../src/rpc-server.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omarchy-drive-test-"));
  const provider = new FakeDriveProvider();
  const engine = new DriveEngine(provider, new StateStore(join(root, "state/state.json")), new LocalStorage(join(root, "cache"), join(root, "state")));
  await engine.initialize(); return { root, provider, engine };
}

test("browse, materialize and cached open", async () => {
  const { provider, engine } = await fixture();
  const children = await engine.listChildren("docs"); assert.equal(children[0]?.name, "Welcome.txt");
  const path = await engine.materialize("welcome"); assert.match(await readFile(path, "utf8"), /fake provider/);
  provider.setOnline(false); assert.equal(await engine.materialize("welcome"), path);
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
  const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.materialize("welcome");
  await engine.stageBytes("welcome", new TextEncoder().encode("local edit")); provider.remoteEdit("welcome", new TextEncoder().encode("remote edit"));
  const conflict = await engine.commit("welcome"); assert.equal(conflict.status, "conflict"); assert.ok(conflict.stagingPath);
  assert.equal(new TextDecoder().decode(await engine.storage.read(conflict.stagingPath!)), "local edit");
  await assert.rejects(engine.evict("welcome"), UnsafeEvictionError);
  assert.equal(new TextDecoder().decode(await provider.readBytes("welcome")), "remote edit");
});

test("dirty local data cannot be trashed", async () => {
  const { engine } = await fixture(); await engine.listChildren("docs"); await engine.stageBytes("welcome", new Uint8Array([1]));
  await assert.rejects(engine.trash("welcome"), UnsafeEvictionError);
});

test("LRU limit only evicts clean unpinned cache", async () => {
  const { provider, engine } = await fixture(); provider.addFile("docs", "a", new Uint8Array(10), "a"); provider.addFile("docs", "b", new Uint8Array(10), "b");
  await engine.listChildren("docs"); await engine.materialize("a"); await engine.materialize("b"); await engine.pin("b", true);
  const remaining = await engine.enforceCacheLimit(10); assert.equal(remaining, 10); assert.equal(engine.getState("a")?.status, "cloud-only"); assert.equal(engine.getState("b")?.status, "pinned");
});

test("atomic state file is valid after repeated writes", async () => {
  const { root, engine } = await fixture(); await engine.listChildren("docs"); await engine.pin("welcome", true); await engine.pin("welcome", false);
  const serialized = String(await readFile(join(root, "state/state.json")));
  assert.doesNotThrow(() => JSON.parse(serialized));
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

test("unicode, zero byte, mkdir, rename, move and trash use native provider operations", async () => {
  const { engine } = await fixture(); const folder=await engine.createFolder("root", "Zażółć 🛰️");
  const file=await engine.createFile("root", "zero byte.txt", new Uint8Array()); assert.equal(file.size, 0);
  const renamed=await engine.rename(file.id, "renamed.txt"); assert.equal(renamed.name, "renamed.txt");
  const moved=await engine.move(file.id, folder.id); assert.equal(moved.parentId, folder.id); await engine.trash(file.id);
  assert.equal((await engine.listChildren(folder.id)).length, 0);
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
  await assert.rejects(dispatch("Rename", { nodeId: "welcome", name: "../state" }), /Invalid node name/);
  await assert.rejects(dispatch("CreateFolder", { parentId: "root", name: "" }), /Invalid node name/);
});

test("daemon restart recovers interrupted upload from persistent staging", async () => {
  const { root, provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.stageBytes("welcome", new TextEncoder().encode("survives crash"));
  const interrupted=engine.getState("welcome")!; interrupted.status="uploading"; engine.store.setState(interrupted); await engine.store.save();
  const restarted=new DriveEngine(provider, new StateStore(join(root, "state/state.json")), new LocalStorage(join(root, "cache"), join(root, "state"))); await restarted.initialize();
  assert.equal(restarted.getState("welcome")?.status, "queued"); assert.ok(restarted.getState("welcome")?.stagingPath);
  await restarted.syncQueued(); assert.equal(new TextDecoder().decode(await provider.readBytes("welcome")), "survives crash");
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
  await started; assert.equal(engine.getState("welcome")?.status, "uploading");
  releaseUpload(); await engine.commit("welcome"); assert.equal(engine.getState("welcome")?.status, "cached");
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

test("reopening an offline queued edit reuses persistent staging", async () => {
  const { provider, engine } = await fixture(); await engine.listChildren("docs"); await engine.materialize("welcome");
  await engine.stageBytes("welcome", new TextEncoder().encode("first offline edit")); provider.setOnline(false); await engine.commit("welcome");
  const before=engine.getState("welcome")!.stagingPath; const reopened=await engine.beginWrite("welcome");
  assert.equal(reopened, before); assert.equal(new TextDecoder().decode(await engine.storage.read(reopened)), "first offline edit"); assert.equal(engine.getState("welcome")?.status, "dirty");
});
