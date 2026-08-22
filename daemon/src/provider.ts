import type { DriveEvent, DriveNode } from "./domain.ts";

export interface DownloadResult {
  revision: string;
}

export interface AccountInfo {
  email: string;
  displayName?: string;
  usedBytes: number;
  totalBytes: number;
}

export type RequestPriority = "interactive" | "background";

export interface UploadInput {
  parentId: string;
  nodeId?: string;
  name: string;
  sourcePath: string;
  expectedSize: number;
  expectedRevision?: string;
  modifiedAt: number;
  knownRemote?: DriveNode;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface DriveProvider {
  readonly kind: "fake" | "proton-sdk" | "proton-cli";
  // Providers that only report progress on completion (for example the
  // process-based CLI) expose transfers as indeterminate instead of showing
  // a frozen progress bar.
  readonly progressSupported?: boolean;
  primeNodes?(nodes: DriveNode[]): void;
  getAccountInfo?(priority?: RequestPriority): Promise<AccountInfo | null>;
  getRoot(priority?: RequestPriority): Promise<DriveNode>;
  getNode(nodeId: string): Promise<DriveNode>;
  listChildren(parentId: string, priority?: RequestPriority): Promise<DriveNode[]>;
  downloadToPath(nodeId: string, targetPath: string, onProgress?: (done: number, total: number) => void, knownNode?: DriveNode): Promise<DownloadResult>;
  upload(input: UploadInput): Promise<DriveNode>;
  createFolder(parentId: string, name: string, signal?: AbortSignal): Promise<DriveNode>;
  rename(nodeId: string, name: string, knownNode?: DriveNode, signal?: AbortSignal): Promise<DriveNode>;
  move(nodeId: string, parentId: string, knownNode?: DriveNode, signal?: AbortSignal): Promise<DriveNode>;
  trash(nodeId: string, signal?: AbortSignal): Promise<void>;
  getEvents(afterId?: string): AsyncIterable<DriveEvent>;
}
