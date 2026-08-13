import type { DriveEvent, DriveNode } from "./domain.ts";

export interface DownloadResult {
  revision: string;
}

export interface UploadInput {
  parentId: string;
  nodeId?: string;
  name: string;
  sourcePath: string;
  expectedSize: number;
  expectedRevision?: string;
  modifiedAt: number;
  onProgress?: (done: number, total: number) => void;
}

export interface DriveProvider {
  readonly kind: "fake" | "proton-sdk";
  getRoot(): Promise<DriveNode>;
  getNode(nodeId: string): Promise<DriveNode>;
  listChildren(parentId: string): Promise<DriveNode[]>;
  downloadToPath(nodeId: string, targetPath: string, onProgress?: (done: number, total: number) => void): Promise<DownloadResult>;
  upload(input: UploadInput): Promise<DriveNode>;
  createFolder(parentId: string, name: string): Promise<DriveNode>;
  rename(nodeId: string, name: string): Promise<DriveNode>;
  move(nodeId: string, parentId: string): Promise<DriveNode>;
  trash(nodeId: string): Promise<void>;
  getEvents(afterId?: string): AsyncIterable<DriveEvent>;
}
