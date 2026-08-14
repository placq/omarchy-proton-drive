import assert from "node:assert/strict";
import test from "node:test";
import { OfficialCliProvider } from "../src/official-cli-provider.ts";

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
  const provider = new OfficialCliProvider("/unused", async () => { throw new Error("You need to login first"); });
  assert.equal(await provider.getAccountInfo(), null);
});
