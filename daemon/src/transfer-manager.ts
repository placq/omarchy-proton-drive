import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Transfer } from "./domain.ts";

export class TransferManager extends EventEmitter {
  static readonly PROGRESS_EMIT_INTERVAL_MS = 100;
  static readonly MAX_RETAINED_TRANSFERS = 256;
  private transfers = new Map<string, Transfer>();
  private progressEmittedAt = new Map<string, number>();
  private pendingProgress = new Map<string, NodeJS.Timeout>();
  start(nodeId: string, direction: Transfer["direction"], name: string, total: number, initialState: Transfer["state"] = "running"): Transfer {
    const bytesTotal = Number.isFinite(total) && total > 0 ? total : 0;
    const transfer: Transfer = { id: randomUUID(), nodeId, direction, name, bytesDone: 0, bytesTotal, state: initialState };
    this.transfers.set(transfer.id, transfer); this.emitChanged(transfer); return transfer;
  }
  begin(id: string): void { const t = this.require(id); t.state = "running"; this.emitChanged(t); }
  progress(id: string, done: number): void {
    const t = this.require(id);
    if (!Number.isFinite(done)) return;
    const nonNegative = Math.max(0, done);
    const next = Math.max(t.bytesDone, Math.min(nonNegative, t.bytesTotal || nonNegative));
    if (next === t.bytesDone) return;
    t.bytesDone = next;
    const elapsed = Date.now() - (this.progressEmittedAt.get(id) ?? 0);
    if (elapsed >= TransferManager.PROGRESS_EMIT_INTERVAL_MS) { this.emitChanged(t); return; }
    if (this.pendingProgress.has(id)) return;
    const timer = setTimeout(() => {
      this.pendingProgress.delete(id);
      const latest = this.transfers.get(id);
      if (latest && latest.state === "running") this.emitChanged(latest);
    }, TransferManager.PROGRESS_EMIT_INTERVAL_MS - elapsed);
    timer.unref();
    this.pendingProgress.set(id, timer);
  }
  finish(id: string): void { const t = this.require(id); t.bytesDone = t.bytesTotal; t.state = "complete"; this.emitChanged(t); this.pruneTerminal(); }
  fail(id: string, error: unknown): void { const t = this.require(id); t.state = "failed"; t.error = error instanceof Error ? error.message : String(error); this.emitChanged(t); this.pruneTerminal(); }
  cancel(id: string): void { const t = this.require(id); t.state = "cancelled"; this.emitChanged(t); this.pruneTerminal(); }
  list(activeOnly = false): Transfer[] { return [...this.transfers.values()].filter(t => !activeOnly || ["queued", "running", "paused"].includes(t.state)).map(t => structuredClone(t)); }
  private emitChanged(transfer: Transfer): void {
    const pending = this.pendingProgress.get(transfer.id);
    if (pending) { clearTimeout(pending); this.pendingProgress.delete(transfer.id); }
    this.progressEmittedAt.set(transfer.id, Date.now());
    this.emit("changed", structuredClone(transfer));
  }
  private pruneTerminal(): void {
    if (this.transfers.size <= TransferManager.MAX_RETAINED_TRANSFERS) return;
    for (const [id, transfer] of this.transfers) {
      if (["queued", "running", "paused"].includes(transfer.state)) continue;
      this.transfers.delete(id);
      this.progressEmittedAt.delete(id);
      if (this.transfers.size <= TransferManager.MAX_RETAINED_TRANSFERS) break;
    }
  }
  private require(id: string): Transfer { const t = this.transfers.get(id); if (!t) throw new Error(`Unknown transfer: ${id}`); return t; }
}
