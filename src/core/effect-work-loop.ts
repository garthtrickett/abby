import type { EffectRecovery, EffectRecoveryReport } from "./effect-recovery.ts";
import { err } from "./model.ts";
import type { Result, TransitionFailure } from "./model.ts";
import { systemTimer } from "./timer.ts";
import type { TimerPort } from "./timer.ts";

export type EffectWorkFailure = TransitionFailure | Readonly<{ kind: "workerUnavailable"; stage: "clock" | "recovery" }>;

/** Host-started periodic recovery; it continues running when no voice session is attached. */
export class EffectWorkLoop {
  private readonly recovery: Pick<EffectRecovery, "recover">;
  private readonly onTick: (result: Result<EffectRecoveryReport, EffectWorkFailure>) => void;
  private readonly clock: () => string;
  private readonly intervalMs: number;
  private readonly timer: TimerPort;
  private running = false;
  private scheduled: unknown;
  private inFlight: Promise<Result<EffectRecoveryReport, EffectWorkFailure>> | undefined;
  private tickInFlight: Promise<void> | undefined;

  constructor(recovery: Pick<EffectRecovery, "recover">, onTick: (result: Result<EffectRecoveryReport, EffectWorkFailure>) => void,
              options: Readonly<{ intervalMs?: number; clock?: () => string; timer?: TimerPort }> = {}) {
    const interval = options.intervalMs ?? 5_000;
    if (!Number.isSafeInteger(interval) || interval < 250 || interval > 60_000) throw new RangeError("intervalMs must be 250..60000");
    this.recovery = recovery;
    this.onTick = onTick;
    this.intervalMs = interval;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.timer = options.timer ?? systemTimer;
  }

  runOnce(): Promise<Result<EffectRecoveryReport, EffectWorkFailure>> {
    if (this.inFlight) return this.inFlight;
    const work = (async (): Promise<Result<EffectRecoveryReport, EffectWorkFailure>> => {
      let now: string;
      try { now = this.clock(); }
      catch { return err({ kind: "workerUnavailable", stage: "clock" }); }
      if (!Number.isFinite(Date.parse(now))) return err({ kind: "workerUnavailable", stage: "clock" });
      try { return await this.recovery.recover(now); }
      catch { return err({ kind: "workerUnavailable", stage: "recovery" }); }
    })();
    this.inFlight = work;
    const clear = () => { if (this.inFlight === work) this.inFlight = undefined; };
    void work.then(clear, clear);
    return work;
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
