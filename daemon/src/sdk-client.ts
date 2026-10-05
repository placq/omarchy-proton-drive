import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CryptoProxy } from "@protontech/crypto";
import { Api as CryptoApi } from "@protontech/crypto/proxy/endpoint/api.ts";
import { ProtonDriveClient, MemoryCache, OpenPGPCryptoWithCryptoProxy } from "@protontech/drive-sdk";
import type { Logger, CachedCryptoMaterial, ProtonDriveCache } from "@protontech/drive-sdk";
import { ApiClient, initAccount } from "../../vendor/proton-drive-sdk-account/src/index.ts";
import { processDriveRequirementHeaders, SUPPORTED_REQUIREMENT_MASK_BY_SCOPE } from "../../vendor/proton-drive-sdk-account/src/apiRequirements.ts";
import { MessageEmitter } from "../../vendor/proton-drive-sdk-account/src/messageEmitter.ts";
import { HTTPClient } from "../../vendor/proton-drive-sdk-cli-api/src/httpClient.ts";
import { DriveAccountAdapter } from "../../vendor/proton-drive-sdk-cli-api/src/driveAccountAdapter.ts";
import { PROTON_APP_VERSION, PROTON_SDK_VERSION } from "./sdk-versions.ts";
import { SecretSessionCredentials, bunSecretsBackend, type SecretsBackend } from "./secret-session.ts";

const DEFAULT_BASE_URL = "drive-api.proton.me";
const CLIENT_UID_FILE = "clientUid.json";

export interface SdkOptions {
  baseUrl?: string;
  logger: Logger;
  backend?: SecretsBackend;
}

export interface SdkClientBundle {
  client: ProtonDriveClient;
  account: DriveAccountAdapter;
  isLoggedIn: () => boolean;
}

/** Logger bridge so SDK and account modules record through the daemon's JSON stderr stream. */
export function sdkJsonLogger(scope: string): Logger {
  return {
    debug(message: string) { process.stderr.write(JSON.stringify({ level: "debug", scope, event: limit(message) }) + "\n"); },
    info(message: string) { process.stderr.write(JSON.stringify({ level: "info", scope, event: limit(message) }) + "\n"); },
    warn(message: string) { process.stderr.write(JSON.stringify({ level: "warn", scope, event: limit(message) }) + "\n"); },
    error(message: string, error?: unknown) { process.stderr.write(JSON.stringify({ level: "error", scope, event: limit(message), code: (error as Error | undefined)?.name }) + "\n"); },
  };
}

function limit(message: string): string {
  return message.length > 400 ? message.slice(0, 400) : message;
}

let cryptoProxyInitialized = false;
function initializeCryptoProxy() {
  if (cryptoProxyInitialized) return;
  CryptoApi.init({});
  CryptoProxy.setEndpoint(new CryptoApi(), endpoint => endpoint.clearKeyStore());
  cryptoProxyInitialized = true;
}

function requirementAfterResponseHook(logger: Logger) {
  const notices = new MessageEmitter();
  return (_request: unknown, _options: unknown, response: Response) => {
    processDriveRequirementHeaders(response.headers, {
      clientSdkVersion: PROTON_SDK_VERSION,
      supportedRequirementMasksByScope: SUPPORTED_REQUIREMENT_MASK_BY_SCOPE,
      onUnsupportedFeature: scope => {
        notices.emitOnce(`Update needed: unsupported feature for ${scope}`, message => logger.warn(message));
      },
      onRequiredUpdate: requiredVersion => {
        notices.emitOnce(`Update required: required SDK version ${requiredVersion} or newer (client reports ${PROTON_SDK_VERSION})`, message => logger.warn(message));
      },
      onSuggestedUpdate: suggestedVersion => {
        notices.emitOnce(`Update recommended: suggested SDK version ${suggestedVersion} or newer (client reports ${PROTON_SDK_VERSION})`, message => logger.info(message));
      },
    });
  };
}

interface ClientUidFile { clientUid: string }

async function reuseClientUid(): Promise<string> {
  const path = join((process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share")), "proton-drive-cli", CLIENT_UID_FILE);
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as ClientUidFile;
    if (typeof data.clientUid === "string" && data.clientUid) return data.clientUid;
  } catch { /* the daemon is anonymous when the CLI never ran here */ }
  return "";
}

/**
 * Constructs the in-process Proton Drive SDK client on top of the session
 * snapshot that the official CLI keeps in the OS secret service. Login,
 * two-factor and logout stay inside the CLI; this factory only reuses the
 * stored session and never prints or transports its contents.
 */
export async function buildSdkClient(options: SdkOptions): Promise<SdkClientBundle> {
  const logger = options.logger;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  initializeCryptoProxy();
  const credentials = new SecretSessionCredentials(options.backend ?? bunSecretsBackend, logger);
  await credentials.load();
  if (!credentials.isLoggedIn()) {
    throw new Error("Proton Drive authentication is required: run 'proton-drive auth login' once so the daemon can reuse the stored session");
  }
  const apiClient = new ApiClient({
    baseUrl,
    appVersion: PROTON_APP_VERSION,
    credentials,
    logger,
    headers: { "x-pm-drive-sdk-version": PROTON_SDK_VERSION },
    afterResponseHooks: [requirementAfterResponseHook(logger)],
  });
  const account = await initAccount({
    authClientId: "external-drive",
    apiClient,
    credentials,
    cryptoProxy: CryptoProxy,
    logger,
  });
  const client = new ProtonDriveClient({
    httpClient: new HTTPClient(apiClient),
    entitiesCache: new MemoryCache<string>() as unknown as ProtonDriveCache<string>,
    cryptoCache: new MemoryCache<CachedCryptoMaterial>() as unknown as ProtonDriveCache<CachedCryptoMaterial>,
    account: new DriveAccountAdapter(account.addresses),
    openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
    srpModule: account.srp,
    config: { baseUrl, clientUid: await reuseClientUid() },
  });
  return { client, account: new DriveAccountAdapter(account.addresses), isLoggedIn: () => credentials.isLoggedIn() };
}
