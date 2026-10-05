export const PROTON_APP_VERSION = "external-drive-omarchy_drive@1.0.2";
export const PROTON_SDK_VERSION = "js@0.21.0";

interface SdkSessionInfo {
  uid: string;
  accessToken: string;
  refreshToken?: string;
}

/**
 * The account module's session contract, upstream
 * `proton-drive-sdk-account`'s `SessionCredentials`.
 */
interface SdkSessionCredentials {
  readonly uid: string | undefined;
  readonly accessToken: string | undefined;
  readonly refreshToken: string | undefined;
  on(event: "sessionInfoChanged", callback: () => void): void;
  isLoggedIn(): boolean;
  isTelemetryEnabled(): boolean;
  getUserKeyPassword(): string | undefined;
  load(): Promise<void>;
  setUserKeyPassword(userKeyPassword: string): Promise<void>;
  setSessionInfo(info: SdkSessionInfo): Promise<void>;
  setTelemetryEnabled(enabled: boolean): Promise<void>;
  signOut(): Promise<void>;
}

export type { SdkSessionCredentials as SessionCredentials, SdkSessionInfo as SessionInfo };
interface SdkBridgeLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export type { SdkBridgeLogger as Logger };
