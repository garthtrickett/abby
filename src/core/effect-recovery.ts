import { EffectWorker } from "./effect-worker.ts";
import type { HostEffects, OperatorAlertHost, StaffLifecycleHost } from "./host.ts";
import type { LedgerStore } from "./ledger.ts";
import { err, ok } from "./model.ts";
import type { LocationScope, RecoverableEffectRef, Result, TransitionFailure } from "./model.ts";
import { CallRuntime } from "./runtime.ts";

export type EffectHostLookup = (scope: LocationScope) => (HostEffects & Partial<StaffLifecycleHost & OperatorAlertHost>) | undefined;
export type EffectRecoveryReport = Readonly<{
  scanned: number;
  processed: number;
  recovered: number;
  deferred: number;
  failed: readonly Readonly<{ effectId: string; kind: "hostUnavailable" | "effectFailure" | "recoveryFailure" }>[];
}>;

/** Bounded startup/periodic scan. One call is processed in order; different calls run concurrently. */
export class EffectRecovery {
  private readonly ledger: LedgerStore;
  private readonly hostLookup: EffectHostLookup;
  private readonly scope: LocationScope | undefined;
  private scanCursor: string | undefined;

  constructor(ledger: LedgerStore, hostLookup: EffectHostLookup, scope?: LocationScope) {
    this.ledger = ledger;
    this.hostLookup = hostLookup;
    this.scope = scope;
  }

  private async attempt(ref: RecoverableEffectRef, now: string): Promise<"processed" | "recovered" | "deferred" | { effectId: string; kind: "hostUnavailable" | "effectFailure" | "recoveryFailure" }> {
    const runtime = new CallRuntime(this.ledger, ref.scope);
    const current = await runtime.read(ref.callId);
    if (!current.ok) return { effectId: ref.effectId, kind: "recoveryFailure" };
    const effect = current.value.effects[ref.effectId];
    if (!effect || effect.kind !== ref.kind || effect.status !== ref.status) return "deferred";
    if (effect.status === "possiblySent") {
      const recovered = effect.kind === "hostWrite" ? await runtime.recoverHostPossiblySent(ref.callId, effect.id, now)
        : effect.kind === "staffTask" ? await runtime.recoverStaffPossiblySent(ref.callId, effect.id, now)
        : effect.kind === "staffChange" ? await runtime.recoverStaffChangePossiblySent(ref.callId, effect.id, now)
        : effect.kind === "operatorAlert" ? await runtime.recoverOperatorAlertPossiblySent(ref.callId, effect.id, now)
        : err({ kind: "invalidTransition" as const });
      if (recovered.ok) return "recovered";
      const latest = await runtime.read(ref.callId);
      return latest.ok && latest.value.effects[ref.effectId]?.status !== "possiblySent" ? "deferred"
        : { effectId: ref.effectId, kind: "recoveryFailure" };
    }
    let host: (HostEffects & Partial<StaffLifecycleHost & OperatorAlertHost>) | undefined;
    try { host = this.hostLookup(ref.scope); }
    catch { return { effectId: ref.effectId, kind: "hostUnavailable" }; }
    if (!host) return { effectId: ref.effectId, kind: "hostUnavailable" };
    try {
      await new EffectWorker(runtime, host).process(ref.callId, ref.effectId, now);
      return "processed";
    } catch {
      const latest = await runtime.read(ref.callId);
      if (latest.ok && (effect.kind === "operatorAlert" || effect.kind === "operatorAlertReconcile") &&
          ["failed", "uncertain"].includes(latest.value.staffItems[effect.alert.taskKey]?.alerts?.[effect.alert.reason] ?? "")) {
        return { effectId: ref.effectId, kind: "effectFailure" };
      }
      return latest.ok && latest.value.effects[ref.effectId]?.status !== "pending" ? "deferred"
        : { effectId: ref.effectId, kind: "effectFailure" };
    }
  }

  async recover(now: string): Promise<Result<EffectRecoveryReport, TransitionFailure>> {
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    let found = await this.ledger.findRecoverableEffects(now, this.scope, this.scanCursor);
    if (!found.ok) return found;
    if (found.value.length === 0 && this.scanCursor) {
      this.scanCursor = undefined;
      found = await this.ledger.findRecoverableEffects(now, this.scope);
      if (!found.ok) return found;
    }
    const refs = found.value;
    const byCall = new Map<string, RecoverableEffectRef[]>();
    for (const ref of refs) {
      const key = JSON.stringify([ref.scope.tenantId, ref.scope.clinicId, ref.scope.locationId, ref.callId]);
      const group = byCall.get(key) ?? [];
      group.push(ref);
      byCall.set(key, group);
    }
    const outcomes: Awaited<ReturnType<EffectRecovery["attempt"]>>[] = [];
    const groups = [...byCall.values()];
    for (let index = 0; index < groups.length; index += 4) {
      const batch = await Promise.all(groups.slice(index, index + 4).map(async group => {
        const results: Awaited<ReturnType<EffectRecovery["attempt"]>>[] = [];
        for (const ref of group) results.push(await this.attempt(ref, now));
        return results;
      }));
      for (const result of batch) outcomes.push(...result);
    }
    if (refs.length > 0) this.scanCursor = refs[refs.length - 1]!.effectId;
    return ok({ scanned: refs.length, processed: outcomes.filter(item => item === "processed").length,
      recovered: outcomes.filter(item => item === "recovered").length,
      deferred: outcomes.filter(item => item === "deferred").length,
      failed: outcomes.filter((item): item is Extract<typeof item, { effectId: string }> => typeof item === "object") });
  }
}
