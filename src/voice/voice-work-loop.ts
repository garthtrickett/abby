import { err, ok } from "../core/model.ts";
import type { LocationScope, Result, TransitionFailure } from "../core/model.ts";
import type { CallLivenessMonitor } from "./call-liveness-monitor.ts";
import type { DeliveryAttempt, DeliveryFailure, PresentationDispatcher, RecoveryReport } from "./presentation-dispatcher.ts";

export type WorkFailure = TransitionFailure | DeliveryFailure |
  Readonly<{ kind: "workerUnavailable"; stage: "clock" | "expiry" | "recovery" | "wake" }>;
export type WorkReport = Readonly<{ expired: number; recovery: RecoveryReport }>;
export type WorkTimer = Readonly<{
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}>;

const systemTimer: WorkTimer = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Schedules bounded recovery work. The host owns the process lifecycle and call registry. */
export class VoiceWorkLoop {
  private readonly liveness: Pick<CallLivenessMonitor, "expireDue">;
  private readonly dispatcher: Pick<PresentationDispatcher, "recover" | "wake">;
  private readonly clock: () => string;
  private readonly onTick: (result: Result<WorkReport, WorkFailure>) => void;
  private readonly intervalMs: number;
  private readonly timer: WorkTimer;
  private running = false;
  private scheduled: unknown;
  private inFlight: Promise<Result<WorkReport, WorkFailure>> | undefined;
  private tickInFlight: Promise<void> | undefined;

  constructor(
    liveness: Pick<CallLivenessMonitor, "expireDue">,
    dispatcher: Pick<PresentationDispatcher, "recover" | "wake">,
    onTick: (result: Result<WorkReport, WorkFailure>) => void,
    options: Readonly<{ intervalMs?: number; clock?: () => string; timer?: WorkTimer }> = {},
  ) {
    const interval = options.intervalMs ?? 5_000;
    if (!Number.isSafeInteger(interval) || interval < 250 || interval > 60_000) throw new RangeError("intervalMs must be 250..60000");
    this.liveness = liveness;
    this.dispatcher = dispatcher;
    this.onTick = onTick;
    this.intervalMs = interval;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.timer = options.timer ?? systemTimer;
  }

  private readClock(): Result<string, WorkFailure> {
    try {
      const now = this.clock();
      return typeof now === "string" && Number.isFinite(Date.parse(now)) ? ok(now) : err({ kind: "workerUnavailable", stage: "clock" });
    } catch {
      return err({ kind: "workerUnavailable", stage: "clock" });
    }
  }

  private async perform(): Promise<Result<WorkReport, WorkFailure>> {
    const time = this.readClock();
    if (!time.ok) return time;
    let expired: Awaited<ReturnType<CallLivenessMonitor["expireDue"]>>;
    try { expired = await this.liveness.expireDue(time.value); }
    catch { return err({ kind: "workerUnavailable", stage: "expiry" }); }
    if (!expired.ok) return expired;
    try {
      const recovery = await this.dispatcher.recover(time.value);
      return recovery.ok ? ok({ expired: expired.value, recovery: recovery.value }) : recovery;
    } catch {
      return err({ kind: "workerUnavailable", stage: "recovery" });
    }
  }

  runOnce(): Promise<Result<WorkReport, WorkFailure>> {
    if (this.inFlight) return this.inFlight;
    const work = this.perform();
    this.inFlight = work;
    const clear = () => { if (this.inFlight === work) this.inFlight = undefined; };
    void work.then(clear, clear);
    return work;
  }

  async notifyCommitted(callId: string, scope: LocationScope): Promise<Result<DeliveryAttempt, WorkFailure>> {
    const time = this.readClock();
    if (!time.ok) return time;
    try { return await this.dispatcher.wake(callId, scope, time.value); }
    catch { return err({ kind: "workerUnavailable", stage: "wake" }); }
  }

  private schedule(delayMs: number): void {
    this.scheduled = this.timer.schedule(() => {
      const tick = this.tick();
      this.tickInFlight = tick;
      const clear = () => { if (this.tickInFlight === tick) this.tickInFlight = undefined; };
      void tick.then(clear, clear);
    }, delayMs);
  }

  private async tick(): Promise<void> {
    this.scheduled = undefined;
    if (!this.running) return;
    const result = await this.runOnce();
    try { this.onTick(result); }
    finally { if (this.running) this.schedule(this.intervalMs); }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.scheduled !== undefined) {
      this.timer.cancel(this.scheduled);
      this.scheduled = undefined;
    }
    await (this.tickInFlight ?? this.inFlight);
  }
}
