import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result, StaffAlertReason, TransitionFailure } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";
import { StaffQueue } from "./staff-queue.ts";

/** Stages stable alert intents for one configured clinic location. Sending remains outbox work. */
export class StaffAlertMonitor {
  private readonly ledger: LedgerStore;
  private readonly scope: LocationScope;
  private cursor: string | undefined;

  constructor(ledger: LedgerStore, scope: LocationScope) {
    this.ledger = ledger;
    this.scope = structuredClone(scope);
  }

  async scan(now: string): Promise<Result<number, TransitionFailure>> {
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    const queue = new StaffQueue(this.ledger, () => now);
    let found = await queue.list(this.scope, this.cursor);
    if (!found.ok) return found;
    if (found.value.items.length === 0 && this.cursor) {
      this.cursor = undefined;
      found = await queue.list(this.scope);
      if (!found.ok) return found;
    }
    let staged = 0;
    for (const entry of found.value.items) {
      const reasons: StaffAlertReason[] = [];
      if (entry.overdue) reasons.push("overdue");
      if (entry.status === "needsReview" || entry.status === "failed" || entry.reviewRequired) reasons.push("needsReview");
      const runtime = new CallRuntime(this.ledger, this.scope);
      for (const reason of reasons) {
        const current = await runtime.read(entry.callId);
        if (!current.ok) return current;
        const effectId = `${entry.taskKey}:alert:${reason}`;
        if (current.value.effects[effectId]) continue;
        const result = await runtime.requestStaffAlert(entry.callId, entry.taskKey, reason, now);
        if (!result.ok) {
          if (result.error.kind === "versionConflict") continue;
          return result;
        }
        if (result.value.effects[effectId]) staged += 1;
      }
    }
    if (found.value.items.length > 0) this.cursor = found.value.items[found.value.items.length - 1]!.taskKey;
    return ok(staged);
  }
}
