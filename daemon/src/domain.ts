export type NodeKind = "file" | "folder";
export type SyncStatus =
  | "cloud-only" | "cached" | "pinned" | "downloading" | "uploading"
  | "dirty" | "queued" | "conflict" | "error";

export interface DriveNode {
  id: string;
  parentId: string | null;
  name: string;
  kind: NodeKind;
  size: number;
  modifiedAt: number;
  revision: string;
}

export interface NodeState {
  nodeId: string;
  status: SyncStatus;
  pinned: boolean;
  remoteRevision: string;
  baseRevision?: string;
  cachePath?: string;
  stagingPath?: string;
  lastAccessedAt: number;
  error?: string;
}

export interface Transfer {
  id: string;
  nodeId: string;
  direction: "upload" | "download";
  name: string;
  bytesDone: number;
  bytesTotal: number;
  state: "queued" | "running" | "paused" | "complete" | "failed" | "cancelled";
  error?: string;
}

export interface DriveEvent {
  id: string;
  type: "created" | "updated" | "moved" | "trashed" | "cursor" | "refresh";
  nodeId: string;
  node?: DriveNode;
}

export class OfflineError extends Error {
  constructor(message = "Proton Drive is offline") { super(message); this.name = "OfflineError"; }
}

export class ConflictError extends Error {
  constructor(message = "Remote revision changed") { super(message); this.name = "ConflictError"; }
}

export class UnsafeEvictionError extends Error {
  constructor(status: SyncStatus) {
    super(`Local content cannot be removed while status is ${status}`);
    this.name = "UnsafeEvictionError";
  }
}
