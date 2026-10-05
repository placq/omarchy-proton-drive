import { randomBytes } from "node:crypto";
import type { Logger } from "./sdk-versions.ts";
import type { SessionCredentials, SessionInfo } from "./sdk-versions.ts";

export interface SecretsBackend {
  get(service: string, name: string): Promise<string | null>;
  set(service: string, name: string, value: string): Promise<void>;
  delete(service: string, name: string): Promise<void>;
}

/** Live backend for the same OS secret-service snapshot the official CLI owns. */
export const bunSecretsBackend: SecretsBackend = {
  async get(service: string, name: string) { return await Bun.secrets.get({ service, name }); },
  async set(service: string, name: string, value: string) { await Bun.secrets.set({ service, name, value }); },
  async delete(service: string, name: string) { await Bun.secrets.delete({ service, name }); },
};

export const CREDENTIALS_SERVICE = "ch.proton.drive/drive-sdk-cli";
export const CREDENTIALS_NAME = "auth-session";

interface StoredSnapshot {
  cachePassword?: string;
  userKeyPassword: string;
  session: { uid: string; accessToken: string; refreshToken?: string };
  telemetryEnabled?: boolean;
}

function parseStoredSnapshot(raw: string | null): StoredSnapshot | null {
  if (raw == null || raw === "") return null;
  try {
    const snapshot = JSON.parse(raw) as StoredSnapshot;
    if (typeof snapshot.userKeyPassword !== "string" || !snapshot.userKeyPassword) return null;
    if (!snapshot.session || typeof snapshot.session.uid !== "string" || typeof snapshot.session.accessToken !== "string") return null;
    if (snapshot.session.refreshToken !== undefined && typeof snapshot.session.refreshToken !== "string") return null;
    if (snapshot.cachePassword !== undefined && typeof snapshot.cachePassword !== "string") return null;
    if (snapshot.telemetryEnabled !== undefined && typeof snapshot.telemetryEnabled !== "boolean") return null;
    return snapshot;
  } catch { return null; }
}

/**
 * Session store reusing the snapshot the official Proton CLI maintains in the
 * operating-system secret service. The daemon never sees a password: login,
 * two-factor and session revocation stay inside the CLI, and this class only
 * reads or updates the same snapshot record the CLI owns.
 *
 * A failed token refresh must never erase the snapshot: the CLI owns its own
 * rotation, and an out-of-order 401 from one writer must fall back to the
 * snapshot the other writer may already have rotated in, not sign the device
 * out.
 */
export class SecretSessionCredentials implements SessionCredentials {
  private sessionInfo?: SessionInfo;
  private userKeyPassword?: string;
  private cachePassword?: string;
  private cachedSnapshot?: StoredSnapshot;
  private telemetryEnabled?: boolean;
  private readonly sessionInfoChangedCallbacks = new Set<() => void>();

  constructor(private readonly backend: SecretsBackend, private readonly logger: Logger) {}

  on(_: "sessionInfoChanged", callback: () => void): void { this.sessionInfoChangedCallbacks.add(callback as () => void); }

  get uid(): string | undefined { return this.sessionInfo?.uid; }
  get accessToken(): string | undefined { return this.sessionInfo?.accessToken; }
  get refreshToken(): string | undefined { return this.sessionInfo?.refreshToken; }

  isLoggedIn(): boolean { return Boolean(this.sessionInfo && this.userKeyPassword); }
  isTelemetryEnabled(): boolean { return this.isLoggedIn() ? this.telemetryEnabled ?? false : false; }
  getUserKeyPassword(): string | undefined { return this.userKeyPassword; }

  async getCachePassword(): Promise<string> {
    if (!this.cachePassword) {
      const snapshot = this.cachedSnapshot ?? parseStoredSnapshot(await this.backend.get(CREDENTIALS_SERVICE, CREDENTIALS_NAME));
      this.cachePassword = snapshot?.cachePassword ?? randomBytes(32).toString("base64");
    }
    return this.cachePassword;
  }

  async load(): Promise<void> {
    const snapshot = parseStoredSnapshot(await this.backend.get(CREDENTIALS_SERVICE, CREDENTIALS_NAME));
    this.cachedSnapshot = snapshot ?? undefined;
    this.sessionInfo = snapshot ? { uid: snapshot.session.uid, accessToken: snapshot.session.accessToken, ...(snapshot.session.refreshToken !== undefined && { refreshToken: snapshot.session.refreshToken }) } : undefined;
    this.userKeyPassword = snapshot?.userKeyPassword;
    this.cachePassword = snapshot?.cachePassword ?? undefined;
    this.telemetryEnabled = snapshot?.telemetryEnabled;
    this.notifySessionInfoChanged();
  }

  async setUserKeyPassword(userKeyPassword: string): Promise<void> {
    this.userKeyPassword = userKeyPassword;
    await this.persistSnapshot();
    this.notifySessionInfoChanged();
  }

  async setSessionInfo(info: SessionInfo): Promise<void> {
    this.sessionInfo = info;
    await this.persistSnapshot();
    this.notifySessionInfoChanged();
  }

  async setTelemetryEnabled(enabled: boolean): Promise<void> {
    this.telemetryEnabled = enabled;
    await this.persistSnapshot();
  }

  async signOut(): Promise<void> {
    const raw = await this.backend.get(CREDENTIALS_SERVICE, CREDENTIALS_NAME);
    if (parseStoredSnapshot(raw)) {
      this.logger.info("Re-reading the CLI session snapshot instead of signing out");
      await this.load();
      if (this.isLoggedIn()) return;
    }
    this.logger.info("CLI session snapshot is gone; acting unauthenticated");
    this.sessionInfo = undefined; this.userKeyPassword = undefined; this.cachePassword = undefined; this.cachedSnapshot = undefined;
    this.notifySessionInfoChanged();
  }

  private async persistSnapshot(): Promise<void> {
    if (!this.userKeyPassword || !this.sessionInfo) return;
    const snapshot: StoredSnapshot = {
      ...(this.cachePassword !== undefined && { cachePassword: this.cachePassword }),
      userKeyPassword: this.userKeyPassword,
      session: { uid: this.sessionInfo.uid, accessToken: this.sessionInfo.accessToken, ...(this.sessionInfo.refreshToken !== undefined && { refreshToken: this.sessionInfo.refreshToken }) },
      ...(this.telemetryEnabled !== undefined && { telemetryEnabled: this.telemetryEnabled }),
    };
    await this.backend.set(CREDENTIALS_SERVICE, CREDENTIALS_NAME, JSON.stringify(snapshot));
    this.cachedSnapshot = snapshot;
  }

  private notifySessionInfoChanged(): void { this.sessionInfoChangedCallbacks.forEach(callback => callback()); }
}
