import { err } from "../core/model.ts";
import type { CallState, Result } from "../core/model.ts";
import { systemTimer } from "./timer.ts";
import type { TimerPort } from "./timer.ts";
import type { VoiceSession, VoiceSessionFailure } from "./voice-session.ts";

export type LeaseRenewalFailure = VoiceSessionFailure | Readonly<{ kind: "renewalUnavailable"; stage: "clock" | "session" }>;

/** One renewal timer per attached call; the host starts it after attach and stops it on disconnect. */
export class VoiceLeaseLoop {
  private readonly session: Pick<VoiceSession, "renew">;
  private readonly onAttempt: (outcome: Result<CallState, LeaseRenewalFailure>) => void;
  private readonly clock: () => string;
  private readonly timer: TimerPort;
  private readonly intervalMs: number;
  private readonly retryMs: number;
  private running = false;
  private scheduled: unknown;
  private inFlight: Promise<void> | undefined;

  constructor(
    session: Pick<VoiceSession, "renew">,
    onAttempt: (outcome: Result<CallState, LeaseRenewalFailure>) => void,
    options: Readonly<{ clock?: () => string; timer?: TimerPort; intervalMs?: number; retryMs?: number }> = {},
  ) {
    const intervalMs = options.intervalMs ?? 10_000;
    const retryMs = options.retryMs ?? 2_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 15_000) throw new RangeError("intervalMs must be 250..15000");
    if (!Number.isSafeInteger(retryMs) || retryMs < 250 || retryMs > 5_000) throw new RangeError("retryMs must be 250..5000");
    this.session = session;
    this.onAttempt = onAttempt;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.timer = options.timer ?? systemTimer;
    this.intervalMs = intervalMs;
    this.retryMs = retryMs;
  }

  private schedule(delayMs: number): void {
    this.scheduled = this.timer.schedule(() => {
      const tick = this.tick();
      this.inFlight = tick;
      const clear = () => { if (this.inFlight === tick) this.inFlight = undefined; };
      void tick.then(clear, clear);
    }, delayMs);
  }

  private async tick(): Promise<void> {
    this.scheduled = undefined;
    if (!this.running) return;
    let outcome: Result<CallState, LeaseRenewalFailure>;
    let now: string;
    try { now = this.clock(); }
    catch { now = ""; }
    if (typeof now !== "string" || !Number.isFinite(Date.parse(now))) {
      outcome = err({ kind: "renewalUnavailable", stage: "clock" });
    } else {
      try { outcome = await this.session.renew(now); }
      catch { outcome = err({ kind: "renewalUnavailable", stage: "session" }); }
    }
    if (this.running && !outcome.ok && (outcome.error.kind === "leaseLost" || outcome.error.kind === "sessionUnknown")) {
      this.running = false;
    } else if (this.running) {
      this.schedule(outcome.ok ? this.intervalMs : this.retryMs);
    }
    this.onAttempt(outcome);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.scheduled !== undefined) {
      this.timer.cancel(this.scheduled);
      this.scheduled = undefined;
    }
    await this.inFlight;
  }
}
