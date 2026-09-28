import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result, TransitionFailure } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";

export class CallLivenessMonitor {
  private readonly ledger: LedgerStore;
  private readonly scope: LocationScope | undefined;

  constructor(ledger: LedgerStore, scope?: LocationScope) {
    this.ledger = ledger;
    this.scope = scope;
  }

  async expireDue(now: string): Promise<Result<number, TransitionFailure>> {
    const admissions = await this.ledger.findExpiredAdmissions(now, this.scope);
    if (!admissions.ok) return admissions;
    let expired = 0;
    for (const receipt of admissions.value) {
      const result = await new CallRuntime(this.ledger, receipt.scope).expireAdmission(receipt.callId, now);
      if (result.ok) {
        expired += 1;
      } else if (result.error.kind === "versionConflict") {
        const current = await this.ledger.read(receipt.callId, receipt.scope);
        if (!current.ok) return current;
        if (current.value.lifecycle === "starting") return err(result.error);
      } else if (result.error.kind !== "invalidTransition") {
        return err(result.error);
      }
    }
    const sessions = await this.ledger.findExpiredSessions(now, this.scope);
    if (!sessions.ok) return sessions;
    for (const receipt of sessions.value) {
      const result = await new CallRuntime(this.ledger, receipt.scope).expireSession(receipt.callId, receipt.lease.sessionId, receipt.lease.version, now);
      if (result.ok) {
        expired += 1;
      } else if (result.error.kind === "versionConflict") {
        const current = await this.ledger.read(receipt.callId, receipt.scope);
        if (!current.ok) return current;
        if (current.value.lifecycle === "active" && current.value.sessionLease?.version === receipt.lease.version) return err(result.error);
      } else if (result.error.kind !== "leaseLost") {
        return err(result.error);
      }
    }
    return ok(expired);
  }
}
