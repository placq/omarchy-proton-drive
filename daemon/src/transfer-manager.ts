import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Transfer } from "./domain.ts";

export class TransferManager extends EventEmitter {
  private transfers = new Map<string, Transfer>();
  start(nodeId: string, direction: Transfer["direction"], name: string, total: number, initialState: Transfer["state"] = "running"): Transfer {
    const transfer: Transfer = { id: randomUUID(), nodeId, direction, name, bytesDone: 0, bytesTotal: total, state: initialState };
    this.transfers.set(transfer.id, transfer); this.emit("changed", structuredClone(transfer)); return transfer;
  }
  begin(id: string): void { const t = this.require(id); t.state = "running"; this.emit("changed", structuredClone(t)); }
  progress(id: string, done: number): void { const t = this.require(id); t.bytesDone = done; this.emit("changed", structuredClone(t)); }
  finish(id: string): void { const t = this.require(id); t.bytesDone = t.bytesTotal; t.state = "complete"; this.emit("changed", structuredClone(t)); }
  fail(id: string, error: unknown): void { const t = this.require(id); t.state = "failed"; t.error = error instanceof Error ? error.message : String(error); this.emit("changed", structuredClone(t)); }
  cancel(id: string): void { const t = this.require(id); t.state = "cancelled"; this.emit("changed", structuredClone(t)); }
  list(activeOnly = false): Transfer[] { return [...this.transfers.values()].filter(t => !activeOnly || ["queued", "running", "paused"].includes(t.state)).map(t => structuredClone(t)); }
  private require(id: string): Transfer { const t = this.transfers.get(id); if (!t) throw new Error(`Unknown transfer: ${id}`); return t; }
}