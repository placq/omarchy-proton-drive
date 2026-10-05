import { join } from "node:path";
import { homedir } from "node:os";
import { FakeDriveProvider } from "./fake-provider.ts";
import { StateStore } from "./state-store.ts";
import { LocalStorage } from "./local-storage.ts";
import { DriveEngine } from "./engine.ts";
import { RpcServer } from "./rpc-server.ts";
import { OfficialCliProvider } from "./official-cli-provider.ts";
import { clampedIntegerSetting } from "./settings.ts";
import type { DriveProvider } from "./provider.ts";

const dataHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state");
const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/tmp/omarchy-drive-${process.getuid?.() ?? "user"}`;
const providerName = process.env.OMARCHY_DRIVE_PROVIDER ?? "unconfigured";
const maintenanceIntervalMs = clampedIntegerSetting("OMARCHY_DRIVE_MAINTENANCE_MS", providerName === "proton-cli" ? 5 * 60_000 : 60_000, 1_000);
const maxCacheBytes = clampedIntegerSetting("OMARCHY_DRIVE_CACHE_BYTES", 20 * 1024 ** 3, 0);

async function loadProvider(): Promise<DriveProvider> {
  if (providerName === "fake") return new FakeDriveProvider();
  if (providerName === "proton-cli") return new OfficialCliProvider(process.env.OMARCHY_DRIVE_CLI ?? join(homedir(), ".local/bin/proton-drive"));
  const { ProtonSdkProvider } = await import("./proton-sdk-provider.ts");
  // The specifier is built at runtime so the type checker does not follow the
  // SDK bundle into the vendored dependency tree; see `checkSdk`'s own notes.
  const entry = await import(new URL("./sdk-client.ts", import.meta.url).href) as unknown as { buildSdkClient: (options: { logger: Logger }) => Promise<{ client: unknown; account: unknown; isLoggedIn: () => boolean }> };
  const bundle = await entry.buildSdkClient({ logger: silentLogger });
  return new ProtonSdkProvider(bundle.client as never, bundle.account as never);
}

interface SdkClientLogger {
  debug(message: string): void; info(message: string): void; warn(message: string): void; error(message: string, error?: unknown): void;
}

type Logger = SdkClientLogger;

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

async function run(provider: DriveProvider, maintenanceIntervalMs: number, maxCacheBytes: number): Promise<void> {
  const stateName = providerName === "fake" ? "state.sqlite" : `state-${provider.kind}.sqlite`;
  const legacyName = providerName === "fake" ? "state.json" : `state-${provider.kind}.json`;
  const engine = new DriveEngine(provider, new StateStore(join(dataHome, "omarchy-drive", stateName), join(dataHome, "omarchy-drive", legacyName)), new LocalStorage(join(cacheHome, "omarchy-drive"), join(dataHome, "omarchy-drive")));
  await engine.initialize();
  const server = new RpcServer(engine, join(runtimeDir, "omarchy-drive.sock"));
  console.log(JSON.stringify({ level: "info", event: "daemon_started", provider: provider.kind }));
  await server.listen();
  const runMaintenance = async () => {
    try { await engine.maintenanceCycle(maxCacheBytes); }
    catch (error) { const detail = error as Error & { code?: string }; console.error(JSON.stringify({ level: "warn", event: "maintenance_failed", code: detail?.code ?? detail?.name ?? "Error" })); }
    setTimeout(() => { void runMaintenance(); }, maintenanceIntervalMs).unref();
  };
  // Give interactive filesystem and status requests a clear queue after
  // startup. Cached metadata already serves browsing while this timer waits.
  setTimeout(() => { void runMaintenance(); }, Math.min(maintenanceIntervalMs, 60_000)).unref();
}

if (!["fake", "proton-cli", "proton-sdk"].includes(providerName)) {
  console.error("Set OMARCHY_DRIVE_PROVIDER=fake, proton-cli or proton-sdk.");
  process.exitCode = 78;
} else {
  let provider: DriveProvider | undefined;
  try {
    provider = await loadProvider();
  } catch (error) {
    const detail = error as Error & { code?: string };
    console.error(JSON.stringify({ level: "error", event: "provider_load_failed", code: detail?.name }));
    if (providerName === "proton-sdk" && /authentication is required/i.test(detail?.message ?? "")) {
      console.error("The proton-sdk provider reuses the official CLI session; run 'proton-drive auth login' once first.");
    } else if (providerName === "proton-sdk") {
      console.error("The proton-sdk provider needs the SDK dependencies; see vendor/proton-drive-sdk-account/PROVENANCE.md and scripts/patch-crypto.sh.");
    } else {
      throw error;
    }
    process.exitCode = 78;
  }
  if (provider) await run(provider, maintenanceIntervalMs, maxCacheBytes);
}
