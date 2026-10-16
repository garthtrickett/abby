import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { ClassMovementStage } from "../core/class-movement-progress.ts";
import type { ClassMoveStageRequestCeilings } from "../cliniko/class-move-workload.ts";
import { withClinikoReservation } from "../cliniko/read-budget.ts";
import type { ClinikoBudgetDenial, ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import type { ClinikoClassMoveFailure, ClinikoClassMoveOutcome, ClinikoClassMovePermit } from "./cliniko-class-attendance-move.ts";

export type ClassMoveStage = ClassMovementStage;
export type ClassMoveStageConfirmation = Readonly<{ contractVersion: string; confirmationRef: string; expiresAt: string; verificationRef: string }>;
/** Each stage requires its own current, independently validated played consent.
 * A nonce or a parsed native review is never sufficient authority. */
export type ClassMoveStagePermit = (query: Parameters<ClinikoClassMovePermit>[0] & Readonly<{
  stage: ClassMoveStage; confirmationRef: string; stagingContractVersion: string;
}>) => Promise<boolean>;
export type ClassMoveStageResult = Readonly<{ kind: "waiting"; stage: ClassMoveStage; denial: ClinikoBudgetDenial }> |
  Readonly<{ kind: "staged"; next: ClassMoveStage; observation: ClinikoClassMoveOutcome }> |
  Readonly<{ kind: "finished"; observation: ClinikoClassMoveOutcome }>;
export type ClinikoStagedClassMove = Readonly<{
  advanceOnce(confirmation: ClassMoveStageConfirmation, signal: AbortSignal, permit: ClassMoveStagePermit): Promise<Result<ClassMoveStageResult, ClinikoClassMoveFailure>>;
}>;
type Config = Readonly<{ version: string; initialExpiresAt: string; initialVerificationRef: string; clock: () => string; signal: AbortSignal; budget: ClinikoRequestBudget;
  requestCeilings: ClassMoveStageRequestCeilings }>;
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
type Pending = { stage: ClassMoveStage; run(signal: AbortSignal): Promise<unknown>; resolve(value: unknown): void; observation(): ClinikoClassMoveOutcome };
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const nonce = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

/** Internal rendezvous for one live native execution. Every provider operation
 * runs inside a separately admitted30-second allocation. Pauses have no write
 * authority. No serialized checkpoint can recreate this owner after process loss;
 * its Cliniko review instead remains for independently authorized staff recovery. */
export class ClassMoveStageControl {
  readonly #config: Config;
  readonly #confirmations = new Set<string>();
  #pending: Pending | undefined;
  #changed = gate();
  #finished?: Result<ClinikoClassMoveOutcome, ClinikoClassMoveFailure>;
  #active: Readonly<{ confirmation: ClassMoveStageConfirmation; stage: ClassMoveStage; permit: ClassMoveStagePermit }> | undefined;
  #busy = false;
  #started = false;
  #closed = false;
  constructor(config: Config) {
    this.#config = config;
    config.signal.addEventListener("abort", this.#onAbort, { once: true });
    if (config.signal.aborted) this.#onAbort();
  }
  #current() { return { pending: this.#pending, finished: this.#finished }; }
  #notify() { const changed = this.#changed; this.#changed = gate(); changed.resolve(); }
  #onAbort = () => { this.#closed = true; this.#pending?.resolve(undefined); this.#notify(); };
  get verificationRef() { return this.#active?.confirmation.verificationRef ?? this.#config.initialVerificationRef; }
  get expiresAt() { return this.#active?.confirmation.expiresAt ?? this.#config.initialExpiresAt; }
  async authorize(query: Parameters<ClinikoClassMovePermit>[0]): Promise<boolean> {
    const active = this.#active;
    if (!active || this.#closed || query.signal.aborted || this.#config.signal.aborted) return false;
    return active.permit({ ...query, stage: active.stage, confirmationRef: active.confirmation.confirmationRef,
      stagingContractVersion: active.confirmation.contractVersion });
  }
  async segment<T>(stage: ClassMoveStage, run: (signal: AbortSignal) => Promise<T>, observation: () => ClinikoClassMoveOutcome): Promise<T | undefined> {
    if (this.#closed || this.#pending) return undefined;
    return new Promise<T | undefined>(resolve => {
      this.#pending = { stage, run, observation, resolve: value => resolve(value as T | undefined) }; this.#notify();
    });
  }
  finish(result: Result<ClinikoClassMoveOutcome, ClinikoClassMoveFailure>) {
    this.#finished ??= result; this.#closed = true;
    this.#config.signal.removeEventListener("abort", this.#onAbort); this.#notify();
  }
  handle(): ClinikoStagedClassMove { return Object.freeze({ advanceOnce: this.advanceOnce.bind(this) }); }
  async advanceOnce(input: ClassMoveStageConfirmation, external: AbortSignal, permit: ClassMoveStagePermit): Promise<Result<ClassMoveStageResult, ClinikoClassMoveFailure>> {
    const c = this.#config, denied = (kind: ClinikoClassMoveFailure["kind"]) => err({ kind });
    if (this.#busy || this.#closed || c.signal.aborted || !(external instanceof AbortSignal) || external.aborted || typeof permit !== "function") return denied("unavailable");
    let now: number;
    try { now = Date.parse(c.clock()); } catch { return denied("unavailable"); }
    if (!input || Object.keys(input).sort().join(",") !== "confirmationRef,contractVersion,expiresAt,verificationRef" || input.contractVersion !== c.version ||
        typeof input.verificationRef !== "string" || !input.verificationRef.trim() || input.verificationRef.trim() !== input.verificationRef || input.verificationRef.length > 256 || /[\u0000-\u001f\u007f]/.test(input.verificationRef) ||
        !nonce(input.confirmationRef) || this.#confirmations.has(input.confirmationRef.toLowerCase()) || this.#confirmations.size >= 20 ||
        !instant(input.expiresAt) || !Number.isFinite(now) || Date.parse(input.expiresAt) <= now || Date.parse(input.expiresAt) > now + 120000 ||
        !this.#started && Date.parse(input.expiresAt) > Date.parse(c.initialExpiresAt)) return denied("invalidQuery");
    const confirmation = Object.freeze({ ...input }); this.#confirmations.add(input.confirmationRef.toLowerCase()); this.#busy = true;
    let invoked: Pending | undefined;
    try {
      if (!this.#pending && !this.#finished) await this.#changed.promise;
      const pending = this.#pending;
      if (!pending || this.#closed || external.aborted || c.signal.aborted) return denied("unavailable");
      const requests = c.requestCeilings[pending.stage];
      if (!Number.isSafeInteger(requests) || requests === undefined || requests < 1 || requests > 180) return denied("unavailable");
      const signal = AbortSignal.any([external, c.signal, AbortSignal.timeout(30000)]);
      const reserved = await withClinikoReservation(c.budget, requests, signal, async () => {
        invoked = pending; this.#active = { confirmation, stage: pending.stage, permit };
        try { return await pending.run(signal); } finally { this.#active = undefined; }
      });
      if (reserved.kind === "denied") return ok({ kind: "waiting", stage: pending.stage, denial: reserved.denial });
      this.#started = true;
      this.#pending = undefined;
      const next = this.#changed.promise;
      if (reserved.kind === "interrupted") {
        this.#closed = true; pending.resolve(undefined);
        return ok({ kind: "finished", observation: { ...structuredClone(pending.observation()), kind: "needsReview" } });
      }
      pending.resolve(reserved.value); await next;
      const current = this.#current();
      if (current.finished) return current.finished.ok ? ok({ kind: "finished", observation: structuredClone(current.finished.value) }) : current.finished;
      if (current.pending) return ok({ kind: "staged", next: current.pending.stage, observation: structuredClone(current.pending.observation()) });
      return ok({ kind: "finished", observation: { ...structuredClone(pending.observation()), kind: "needsReview" } });
    } catch {
      this.#closed = true; this.#pending?.resolve(undefined);
      return invoked ? ok({ kind: "finished", observation: { ...structuredClone(invoked.observation()), kind: "needsReview" } }) : denied("unavailable");
    } finally { this.#busy = false; }
  }
}
