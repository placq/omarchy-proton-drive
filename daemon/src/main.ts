import { join } from "node:path";
import { homedir } from "node:os";
import { FakeDriveProvider } from "./fake-provider.ts";
import { StateStore } from "./state-store.ts";
import { LocalStorage } from "./local-storage.ts";
import { DriveEngine } from "./engine.ts";
import { RpcServer } from "./rpc-server.ts";
import { OfficialCliProvider } from "./official-cli-provider.ts";

const dataHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state");
const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/tmp/omarchy-drive-${process.getuid?.() ?? "user"}`;
const providerName = process.env.OMARCHY_DRIVE_PROVIDER ?? "unconfigured";
const defaultMaintenanceMs = providerName === "proton-cli" ? 5 * 60_000 : 60_000;
const maintenanceIntervalMs = Math.max(1_000, Number(process.env.OMARCHY_DRIVE_MAINTENANCE_MS ?? defaultMaintenanceMs));
const maxCacheBytes = Math.max(0, Number(process.env.OMARCHY_DRIVE_CACHE_BYTES ?? 20 * 1024 ** 3));

if (!["fake", "proton-cli"].includes(providerName)) {
  console.error("Set OMARCHY_DRIVE_PROVIDER=fake or proton-cli.");
  process.exitCode = 78;
} else {
  // ProtonSdkProvider is a tested seam for a future event-driven client and is
  // intentionally not selectable here (see docs/ARCHITECTURE.md).
  const provider = providerName === "fake"
    ? new FakeDriveProvider()
    : new OfficialCliProvider(process.env.OMARCHY_DRIVE_CLI ?? join(homedir(), ".local/bin/proton-drive"));
  const stateName = providerName === "fake" ? "state.sqlite" : `state-${providerName}.sqlite`;
  const legacyName = providerName === "fake" ? "state.json" : `state-${providerName}.json`;
  const engine = new DriveEngine(provider, new StateStore(join(dataHome, "omarchy-drive", stateName), join(dataHome, "omarchy-drive", legacyName)), new LocalStorage(join(cacheHome, "omarchy-drive"), join(dataHome, "omarchy-drive")));
  await engine.initialize();
  const server = new RpcServer(engine, join(runtimeDir, "omarchy-drive.sock"));
  console.log(JSON.stringify({ level: "info", event: "daemon_started", provider: providerName }));
  await server.listen();
  const runMaintenance = async () => {
    try { await engine.maintenanceCycle(maxCacheBytes); }
    catch (error) { console.error(JSON.stringify({ level: "warn", event: "maintenance_failed", error: error instanceof Error ? error.message : String(error) })); }
    setTimeout(() => { void runMaintenance(); }, maintenanceIntervalMs).unref();
  };
  // Give interactive filesystem and status requests a clear queue after
  // startup. Cached metadata already serves browsing while this timer waits.
  setTimeout(() => { void runMaintenance(); }, Math.min(maintenanceIntervalMs, 60_000)).unref();
}
