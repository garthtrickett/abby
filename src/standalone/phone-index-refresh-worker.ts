import { setTimeout as wait } from "node:timers/promises";
import type { ClinikoClinicScope } from "../cliniko/patients.ts";
import type { ClinikoPhoneLookup } from "./cliniko-phone-lookup.ts";
import { PostgresPatientPhoneIndex } from "../storage/postgres-patient-phone-index.ts";
import type { PhoneRefreshGuardResult } from "../storage/postgres-phone-refresh-guard.ts";

export type PhoneIndexRefreshTarget = Readonly<{
  scope: ClinikoClinicScope;
  lookup: Pick<ClinikoPhoneLookup, "refresh">;
  countryCallingCode: string;
  refreshEveryMs: number;
}>;
export type PhoneIndexRefreshResult = Readonly<{
  scope: ClinikoClinicScope;
  kind: "fresh" | "refreshed" | "busy" | "disabled" | "failed";
}>;
export type PhoneRefreshGuard = Readonly<{
  run<T>(scope: ClinikoClinicScope, task: () => Promise<T>):
    Promise<{ ok: true; value: PhoneRefreshGuardResult<T> } | { ok: false; error: { kind: string } }>;
}>;

/** Periodically reconciles the complete phone index outside calls. */
export class PhoneIndexRefreshWorker {
  private readonly targets: readonly PhoneIndexRefreshTarget[];
  private readonly index: PostgresPatientPhoneIndex;
  private readonly clock: () => Date;
  private readonly inFlight = new Map<string, Promise<PhoneIndexRefreshResult>>();
  private readonly guard: PhoneRefreshGuard | undefined;

  constructor(index: PostgresPatientPhoneIndex, targets: readonly PhoneIndexRefreshTarget[], clock: () => Date = () => new Date(),
              guard?: PhoneRefreshGuard) {
    const keys = new Set<string>();
    for (const target of targets) {
      const { tenantId, clinicId } = target.scope;
      const key = JSON.stringify([tenantId, clinicId]);
      if (!tenantId || !clinicId || tenantId.length > 256 || clinicId.length > 256 || keys.has(key) ||
          !/^[1-9][0-9]{0,2}$/.test(target.countryCallingCode) ||
          !Number.isSafeInteger(target.refreshEveryMs) || target.refreshEveryMs < 60_000 ||
          typeof target.lookup?.refresh !== "function") throw new Error("invalid phone-index refresh target");
      keys.add(key);
    }
    this.index = index;
    this.targets = targets.map(target => ({ ...target, scope: { ...target.scope } }));
    this.clock = clock;
    this.guard = guard;
  }

  private async refreshIfDue(target: PhoneIndexRefreshTarget, now: Date): Promise<PhoneIndexRefreshResult> {
    const failed = { scope: target.scope, kind: "failed" } as const;
    try {
      const attempt = async (): Promise<PhoneIndexRefreshResult> => {
        const completed = await this.index.completedAt(target.scope, target.countryCallingCode);
        if (!completed.ok) return failed;
        if (completed.value && now.getTime() >= completed.value.getTime() &&
            now.getTime() - completed.value.getTime() < target.refreshEveryMs) {
          return { scope: target.scope, kind: "fresh" };
        }
        const refreshed = await target.lookup.refresh(target.scope);
        return refreshed.ok ? { scope: target.scope, kind: "refreshed" } :
          refreshed.error.kind === "clinicDisconnected" ? { scope: target.scope, kind: "disabled" } : failed;
      };
      if (!this.guard) return attempt();
      const initial = await this.index.completedAt(target.scope, target.countryCallingCode);
      if (!initial.ok) return failed;
      if (initial.value && now.getTime() >= initial.value.getTime() &&
          now.getTime() - initial.value.getTime() < target.refreshEveryMs) return { scope: target.scope, kind: "fresh" };
      const guarded = await this.guard.run(target.scope, attempt);
      if (!guarded.ok) return failed;
      return guarded.value.kind === "busy" ? { scope: target.scope, kind: "busy" } : guarded.value.value;
    } catch { return failed; }
  }

  private runTarget(target: PhoneIndexRefreshTarget, now: Date): Promise<PhoneIndexRefreshResult> {
    const key = JSON.stringify([target.scope.tenantId, target.scope.clinicId]);
    const active = this.inFlight.get(key);
    if (active) return active;
    const task = this.refreshIfDue(target, now).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, task);
    return task;
  }

  /** Different clinics refresh in parallel; repeated ticks share one in-process scan per clinic. */
  async runOnce(): Promise<readonly PhoneIndexRefreshResult[]> {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("invalid refresh clock");
    return Promise.all(this.targets.map(target => this.runTarget(target, now)));
  }

  async runLoop(signal: AbortSignal, pollEveryMs = 60_000,
                onTick?: (results: readonly PhoneIndexRefreshResult[]) => void): Promise<void> {
    if (!Number.isSafeInteger(pollEveryMs) || pollEveryMs < 1_000) throw new Error("invalid refresh polling interval");
    while (!signal.aborted) {
      const results = await this.runOnce();
      onTick?.(results);
      try { await wait(pollEveryMs, undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
  }
}
