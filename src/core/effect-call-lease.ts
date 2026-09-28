import { randomUUID } from "node:crypto";
import { err, ok } from "./model.ts";
import type { LocationScope, Result, TransitionFailure } from "./model.ts";
import { systemTimer } from "./timer.ts";
import type { TimerPort } from "./timer.ts";

/** Storage operations are atomic and use the storage clock in production. */
export type EffectCallLeaseGuard = Readonly<{ owner: string; version: number }>;

export interface EffectCallLeaseStore {
  claimEffectCall(callId: string, scope: LocationScope, owner: string, leaseMs: number, now: string):
    Promise<Result<Readonly<{ version: number }> | null, TransitionFailure>>;
  renewEffectCall(callId: string, scope: LocationScope, guard: EffectCallLeaseGuard, leaseMs: number, now: string):
    Promise<Result<boolean, TransitionFailure>>;
  releaseEffectCall(callId: string, scope: LocationScope, guard: EffectCallLeaseGuard):
    Promise<Result<boolean, TransitionFailure>>;
}

export type EffectCallLeaseOptions = Readonly<{
  leaseMs?: number;
  renewEveryMs?: number;
  clock?: () => string;
  timer?: TimerPort;
}>;
export type LeasedEffectRun<Value> =
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "completed" | "lost"; value: Value }>;

/** Keeps one call's effect work owned while allowing crash expiry and stale-owner fencing. */
export class EffectCallLeaseCoordinator {
  private readonly store: EffectCallLeaseStore;
  private readonly leaseMs: number;
  private readonly renewEveryMs: number;
  private readonly clock: () => string;
  private readonly timer: TimerPort;

  constructor(store: EffectCallLeaseStore, options: EffectCallLeaseOptions = {}) {
    const leaseMs = options.leaseMs ?? 60_000;
    const renewEveryMs = options.renewEveryMs ?? 15_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 30 || leaseMs > 300_000 ||
        !Number.isSafeInteger(renewEveryMs) || renewEveryMs < 1 || renewEveryMs * 2 >= leaseMs) {
      throw new RangeError("invalid effect-call lease interval");
    }
    this.store = store;
    this.leaseMs = leaseMs;
    this.renewEveryMs = renewEveryMs;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.timer = options.timer ?? systemTimer;
  }

  private now(): Result<string, TransitionFailure> {
    try {
      const value = this.clock();
      return typeof value === "string" && Number.isFinite(Date.parse(value))
        ? ok(value) : err({ kind: "invalidTransition" });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async run<Value>(callId: string, scope: LocationScope, work: (signal: AbortSignal, guard: EffectCallLeaseGuard) => Promise<Value>):
    Promise<Result<LeasedEffectRun<Value>, TransitionFailure>> {
    const clock = this.now();
    if (!clock.ok) return clock;
    const owner = randomUUID();
    let claimed: Awaited<ReturnType<EffectCallLeaseStore["claimEffectCall"]>>;
    try { claimed = await this.store.claimEffectCall(callId, scope, owner, this.leaseMs, clock.value); }
    catch { return err({ kind: "storageFailure" }); }
    if (!claimed.ok) return claimed;
    if (!claimed.value) return ok({ kind: "busy" });
    const guard = { owner, version: claimed.value.version };

    const controller = new AbortController();
    let stopped = false;
    let lost = false;
    let handle: unknown;
    let renewal: Promise<void> | undefined;
    const lose = () => { lost = true; controller.abort(); };
    const schedule = () => {
      if (stopped || lost) return;
      try {
        handle = this.timer.schedule(() => {
          handle = undefined;
          if (stopped) return;
          renewal = (async () => {
            const at = this.now();
            if (!at.ok) { lose(); return; }
            let renewed: Awaited<ReturnType<EffectCallLeaseStore["renewEffectCall"]>>;
            try { renewed = await this.store.renewEffectCall(callId, scope, guard, this.leaseMs, at.value); }
            catch { lose(); return; }
            if (!renewed.ok || !renewed.value) { lose(); return; }
            schedule();
          })();
          void renewal.catch(lose);
        }, this.renewEveryMs);
      } catch { lose(); }
    };
    schedule();

    let value: Value | undefined;
    let workError: unknown;
    let workFailed = false;
    try { value = await work(controller.signal, guard); }
    catch (error) { workError = error; workFailed = true; }
    stopped = true;
    if (handle !== undefined) {
      try { this.timer.cancel(handle); }
      catch { lost = true; }
    }
    if (renewal) await renewal;
    let released: Awaited<ReturnType<EffectCallLeaseStore["releaseEffectCall"]>>;
    try { released = await this.store.releaseEffectCall(callId, scope, guard); }
    catch { return err({ kind: "storageFailure" }); }
    if (!released.ok) return released;
    if (!released.value) lost = true;
    if (workFailed) throw workError;
    return ok({ kind: lost ? "lost" : "completed", value: value as Value });
  }
}
