import { join } from "node:path";
import { homedir } from "node:os";
import { FakeDriveProvider } from "./fake-provider.ts";
import { StateStore } from "./state-store.ts";
import { LocalStorage } from "./local-storage.ts";
import { DriveEngine } from "./engine.ts";
import { RpcServer } from "./rpc-server.ts";

const dataHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state");
const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/tmp/omarchy-drive-${process.getuid?.() ?? "user"}`;
const providerName = process.env.OMARCHY_DRIVE_PROVIDER ?? "unconfigured";
const maintenanceIntervalMs = Math.max(1_000, Number(process.env.OMARCHY_DRIVE_MAINTENANCE_MS ?? 15_000));
const maxCacheBytes = Math.max(0, Number(process.env.OMARCHY_DRIVE_CACHE_BYTES ?? 20 * 1024 ** 3));

if (providerName !== "fake") {
  console.error("Real Proton login bootstrap is not available in the public SDK. Start with OMARCHY_DRIVE_PROVIDER=fake for development.");
  process.exitCode = 78;
} else {
  const engine = new DriveEngine(new FakeDriveProvider(), new StateStore(join(dataHome, "omarchy-drive/state.json")), new LocalStorage(join(cacheHome, "omarchy-drive"), join(dataHome, "omarchy-drive")));
  await engine.initialize();
  const server = new RpcServer(engine, join(runtimeDir, "omarchy-drive.sock"));
  console.log(JSON.stringify({ level: "info", event: "daemon_started", provider: providerName }));
  await server.listen();
  const runMaintenance = async () => {
    try { await engine.maintenanceCycle(maxCacheBytes); }
    catch (error) { console.error(JSON.stringify({ level: "warn", event: "maintenance_failed", error: error instanceof Error ? error.message : String(error) })); }
    setTimeout(() => { void runMaintenance(); }, maintenanceIntervalMs).unref();
  };
  void runMaintenance();
}
