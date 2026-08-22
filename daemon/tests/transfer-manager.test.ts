import assert from "node:assert/strict";
import test from "node:test";
import { TransferManager } from "../src/transfer-manager.ts";

test("transfer progress events are throttled while terminal state stays immediate", async () => {
  const manager = new TransferManager();
  const changes: Array<{ bytesDone: number; state: string }> = [];
  manager.on("changed", transfer => changes.push(transfer));
  const transfer = manager.start("node", "download", "large.bin", 1_000);

  manager.progress(transfer.id, Number.NaN);
  manager.progress(transfer.id, -1);
  for (let done = 1; done <= 100; done += 1) manager.progress(transfer.id, done);
  assert.equal(manager.list()[0]?.bytesDone, 100, "in-memory progress must never be delayed");
  assert.equal(changes.length, 1, "a burst immediately after start must not flood Watch clients");

  await new Promise(resolve => setTimeout(resolve, TransferManager.PROGRESS_EMIT_INTERVAL_MS + 25));
  assert.deepEqual(changes.map(change => change.bytesDone), [0, 100]);

  manager.progress(transfer.id, 200);
  manager.progress(transfer.id, 300);
  manager.finish(transfer.id);
  assert.equal(changes.at(-1)?.bytesDone, 1_000);
  assert.equal(changes.at(-1)?.state, "complete");
  await new Promise(resolve => setTimeout(resolve, TransferManager.PROGRESS_EMIT_INTERVAL_MS + 25));
  assert.equal(changes.at(-1)?.state, "complete", "a delayed progress event must not follow completion");

  const bounded = new TransferManager();
  for (let index = 0; index < TransferManager.MAX_RETAINED_TRANSFERS + 20; index += 1) {
    const item = bounded.start(`node-${index}`, "trash", `item-${index}`, Number.NaN);
    bounded.finish(item.id);
  }
  assert.equal(bounded.list().length, TransferManager.MAX_RETAINED_TRANSFERS);
  assert.equal(bounded.list()[0]?.nodeId, "node-20");
});
