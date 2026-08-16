import assert from "node:assert/strict";
import test from "node:test";
import { OfficialCliProvider } from "../src/official-cli-provider.ts";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AuthenticationRequiredError, OfflineError } from "../src/domain.ts";

test("official CLI provider exposes account identity and Drive quota", async () => {
  const provider = new OfficialCliProvider("/unused", async args => {
    assert.deepEqual(args, ["account", "info", "-j"]);
    return {
      email: "user@proton.me",
      displayName: "Proton User",
      usedBytes: 1024,
      totalBytes: 4096,
    };
  });

  assert.deepEqual(await provider.getAccountInfo(), {
    email: "user@proton.me",
    displayName: "Proton User",
    usedBytes: 1024,
    totalBytes: 4096,
  });
});

test("official CLI provider reports a missing or expired session as signed out", async () => {
  for (const message of ["You need to login first", "401 Unauthorized: session revoked", "session expired"]) {
    const provider = new OfficialCliProvider("/unused", async () => { throw new Error(message); });
    assert.equal(await provider.getAccountInfo(), null);
  }
});

test("official CLI provider classifies temporary failures and redacts CLI output", async () => {
  const offline = new OfficialCliProvider("/unused", async () => { throw new Error("429 rate limit for /my-files/Personal.txt"); });
  await assert.rejects(offline.getRoot(), OfflineError);
  const failed = new OfficialCliProvider("/unused", async () => { throw new Error("failed for /my-files/Personal.txt"); });
  await assert.rejects(failed.getRoot(), error => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /Personal|my-files/);
    return true;
  });
  const auth = new OfficialCliProvider("/unused", async () => { throw new Error("invalid refresh token"); });
  await assert.rejects(auth.getRoot(), AuthenticationRequiredError);
});

test("official CLI provider serializes commands that share the CLI cache", async () => {
  let active = 0;
  let maxActive = 0;
  const provider = new OfficialCliProvider("/unused", async args => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active -= 1;
    if (args[0] === "account") return { email: "user@proton.me", usedBytes: 0, totalBytes: 1 };
    return { uid: "root", name: { ok: true, value: "root" }, type: "folder" };
  });

  await Promise.all([provider.getAccountInfo(), provider.getRoot(), provider.getRoot()]);
  assert.equal(maxActive, 1);
});

test("interactive CLI work jumps ahead of queued background refreshes", async () => {
  const calls: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const provider = new OfficialCliProvider("/unused", async args => {
    calls.push(args[0] === "account" ? "account" : String(args.at(-1)));
    if (calls.length === 1) { firstStarted(); await firstGate; }
    if (args[0] === "account") return { email: "user@proton.me", usedBytes: 0, totalBytes: 1 };
    return { uid: "root", name: { ok: true, value: "root" }, type: "folder" };
  });
  const first = provider.getRoot("background"); await started;
  const second = provider.getRoot("background");
  const interactive = provider.getAccountInfo("interactive");
  releaseFirst(); await Promise.all([first, second, interactive]);
  assert.deepEqual(calls, ["/my-files", "account", "/my-files"]);
});

test("persisted nodes prime CLI paths without a remote tree scan", async () => {
  const calls: string[][] = [];
  const provider = new OfficialCliProvider("/unused", async args => {
    calls.push(args);
    return { uid: "file", parentUid: "docs", name: { ok: true, value: "note.txt" }, type: "file", activeRevision: { uid: "r1" } };
  });
  provider.primeNodes([
    { id: "root", parentId: null, name: "Proton Drive", kind: "folder", size: 0, modifiedAt: 1, revision: "r" },
    { id: "docs", parentId: "root", name: "Documents", kind: "folder", size: 0, modifiedAt: 1, revision: "d" },
    { id: "file", parentId: "docs", name: "note.txt", kind: "file", size: 0, modifiedAt: 1, revision: "r1" },
  ]);
  await provider.getNode("file");
  assert.deepEqual(calls, [["filesystem", "info", "-j", "/my-files/Documents/note.txt"]]);
});

test("official CLI provider performs guarded revision uploads and native mutations", async () => {
  const calls: string[][] = [];
  const nodes = new Map<string, Record<string, unknown>>([
    ["root", { uid: "root", name: { ok: true, value: "root" }, type: "folder" }],
    ["file", { uid: "file", parentUid: "root", name: { ok: true, value: "note.txt" }, type: "file", activeRevision: { uid: "rev-1", claimedSize: 3 } }],
  ]);
  const provider = new OfficialCliProvider("/unused", async args => {
    calls.push(args);
    if (args.includes("filesystem") && args.includes("info")) return args.at(-1) === "/my-files" ? nodes.get("root") : nodes.get("file");
    if (args.includes("filesystem") && args.includes("list")) return [nodes.get("file")];
    if (args.includes("upload")) { nodes.get("file")!.activeRevision = { uid: "rev-2", claimedSize: 3 }; return { transferredItems: 1 }; }
    return {};
  });
  const source = join(tmpdir(), `omarchy-drive-provider-${Date.now()}.txt`);
  await writeFile(source, "new");
  const result = await provider.upload({ parentId: "root", nodeId: "file", name: "note.txt", sourcePath: source, expectedSize: 3, expectedRevision: "rev-1", modifiedAt: Date.now() });
  assert.equal(result.revision, "rev-2");
  assert.ok(calls.some(args => args.includes("create-new-revision")));
  const uploadCall = calls.find(args => args.includes("upload"));
  assert.equal(uploadCall?.at(-1), "-j");
  assert.equal(basename(uploadCall?.at(-3) ?? ""), "note.txt");
});

test("official CLI provider refuses a stale revision before invoking upload", async () => {
  let uploaded = false;
  const provider = new OfficialCliProvider("/unused", async args => {
    if (args.includes("filesystem") && args.includes("info")) {
      return args.at(-1) === "/my-files"
        ? { uid: "root", name: { ok: true, value: "root" }, type: "folder" }
        : { uid: "file", parentUid: "root", name: { ok: true, value: "note.txt" }, type: "file", activeRevision: { uid: "remote-rev" } };
    }
    if (args.includes("upload")) uploaded = true;
    if (args.includes("filesystem") && args.includes("list")) return [{ uid: "file", parentUid: "root", name: { ok: true, value: "note.txt" }, type: "file", activeRevision: { uid: "remote-rev" } }];
    return { uid: "root", name: { ok: true, value: "root" }, type: "folder" };
  });
  await assert.rejects(
    provider.upload({ parentId: "root", nodeId: "file", name: "note.txt", sourcePath: "/tmp/source", expectedSize: 1, expectedRevision: "old-rev", modifiedAt: Date.now() }),
    /Remote revision changed/,
  );
  assert.equal(uploaded, false);
});
