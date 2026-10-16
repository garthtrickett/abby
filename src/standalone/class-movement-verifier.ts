import type { PatientProofHost } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result, VerifiedPatient } from "../core/model.ts";
import { CallerVerificationSession, verificationPrompt } from "./caller-verification-session.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

type Failure = Readonly<{ kind: "verificationUnavailable" }>;
type Preparation = Readonly<{ kind: "ready"; patient: VerifiedPatient }> |
  Readonly<{ kind: "verificationRequired"; prompt: string }>;
const unavailable = () => err({ kind: "verificationUnavailable" as const });

/** Private to one live class movement. Retain the last issued reference so
 * expiry can invoke actual verifier succession before a protected read clears
 * the old grant. Neither succession nor code entry grants phase consent. */
export class ClassMovementVerifier {
  readonly #clock: () => string;
  readonly #lifetime: AbortSignal;
  readonly #subject: Readonly<{ scope: LocationScope; patientRef: string }>;
  #session: CallerVerificationSession;
  #current: VerifiedPatient;
  #pending = false;
  #busy = false;
  #closed = false;
  readonly #onClose = () => this.dispose();
  readonly proof: PatientProofHost;

  private constructor(session: CallerVerificationSession, patient: VerifiedPatient, clock: () => string, lifetime: AbortSignal) {
    this.#session = session; this.#current = structuredClone(patient);
    this.#subject = Object.freeze({ scope: Object.freeze({ ...patient.scope }), patientRef: patient.patientRef });
    this.#clock = clock; this.#lifetime = lifetime;
    this.proof = Object.freeze({ verifyPatient: this.#verify.bind(this) });
    lifetime.addEventListener("abort", this.#onClose, { once: true });
    if (lifetime.aborted) this.dispose();
  }

  static async capture(session: CallerVerificationSession, clock: () => string, lifetime: AbortSignal): Promise<Result<ClassMovementVerifier, Failure>> {
    try {
      if (!(session instanceof CallerVerificationSession) || !(lifetime instanceof AbortSignal) || lifetime.aborted || typeof clock !== "function") return unavailable();
      const patient = await session.verifiedSubject("appointments.reschedule", lifetime);
      if (!patient || lifetime.aborted || !Number.isFinite(Date.parse(clock())) || Date.parse(patient.expiresAt) <= Date.parse(clock())) return unavailable();
      return ok(new ClassMovementVerifier(session, patient, clock, lifetime));
    } catch { return unavailable(); }
  }

  #matches(patient: VerifiedPatient): boolean {
    return sameScope(patient.scope, this.#subject.scope) && patient.patientRef === this.#subject.patientRef;
  }

  async prepare(external: AbortSignal): Promise<Result<Preparation, Failure>> {
    if (this.#closed || this.#busy || !(external instanceof AbortSignal) || external.aborted) return unavailable();
    this.#busy = true;
    const signal = AbortSignal.any([external, this.#lifetime]);
    try {
      const at = Date.parse(this.#clock());
      if (!Number.isFinite(at)) return unavailable();
      if (!this.#pending && at + 120_000 >= Date.parse(this.#current.expiresAt)) {
        // Do not call verifiedSubject/ownedGrant first: either can retire an
        // expired source before renewOnce has pinned its original subject.
        const successor = await this.#session.renewOnce(this.#current.verificationRef, signal);
        if (!successor.ok) { this.dispose(); return unavailable(); }
        if (signal.aborted || this.#closed) { successor.value.dispose(); return unavailable(); }
        this.#session = successor.value; this.#pending = true;
      }
      if (signal.aborted || this.#closed) return unavailable();
      if (this.#pending) {
        this.#session.begin();
        if (signal.aborted || this.#closed) { this.dispose(); return unavailable(); }
        return ok({ kind: "verificationRequired", prompt: verificationPrompt });
      }
      // Preparing a separate confirmation exposes no new protected facts and
      // must not spend the next phase's native allocation before it is held.
      // Every eventual native boundary still uses the actual proof port.
      const grant = await this.ownedGrant(signal);
      if (signal.aborted || this.#closed || !grant) {
        this.dispose(); return unavailable();
      }
      return ok({ kind: "ready", patient: structuredClone(this.#current) });
    } catch { this.dispose(); return unavailable(); }
    finally { this.#busy = false; }
  }

  /** Dedicated private code input only; a success prepares proof, never a send. */
  async submitCode(code: string, external: AbortSignal): Promise<Readonly<{ verified: boolean }>> {
    if (this.#closed || this.#busy || !this.#pending || !(external instanceof AbortSignal) || external.aborted) return { verified: false };
    this.#busy = true;
    const signal = AbortSignal.any([external, this.#lifetime]);
    try {
      const result = await awaitUntilAbort(this.#session.submitCode(code), signal);
      if (!result || signal.aborted || this.#closed) { this.dispose(); return { verified: false }; }
      if (!result.verified) return { verified: false };
      const patient = await this.#session.verifiedSubject("appointments.reschedule", signal);
      if (!patient || !this.#matches(patient) || signal.aborted || this.#closed) { this.dispose(); return { verified: false }; }
      this.#current = structuredClone(patient); this.#pending = false;
      return { verified: true };
    } catch { this.dispose(); return { verified: false }; }
    finally { this.#busy = false; }
  }

  async #verify(scope: LocationScope, reference: string, now: string, external?: AbortSignal) {
    const denied = () => err({ kind: "unavailable" as const, target: "patient" as const });
    try {
      const actual = this.#clock(), at = Date.parse(actual);
      if (this.#closed || this.#pending || external?.aborted || !sameScope(scope, this.#subject.scope) || reference !== this.#current.verificationRef ||
          !Number.isFinite(at) || !Number.isFinite(Date.parse(now)) || Math.abs(Date.parse(now) - at) > 30000 || at >= Date.parse(this.#current.expiresAt)) return denied();
      const session = this.#session, signal = AbortSignal.any([this.#lifetime, ...(external ? [external] : [])]);
      const patient = await session.verifiedSubject("appointments.reschedule", signal);
      return patient && this.#matches(patient) && patient.verificationRef === reference && session === this.#session &&
        !this.#pending && !this.#closed && !signal.aborted ? ok(structuredClone(patient)) : denied();
    } catch { return denied(); }
  }

  /** Private routing metadata, with no protected contact/native observation.
   * Native phase reads and writes still use proof.verifyPatient independently. */
  async ownedGrant(external: AbortSignal): Promise<Readonly<{ verificationRef: string; expiresAt: string }> | undefined> {
    if (this.#closed || this.#pending || external.aborted || this.#lifetime.aborted) return undefined;
    const session = this.#session, signal = AbortSignal.any([external, this.#lifetime]);
    const grant = await session.ownedGrant("appointments.reschedule", signal);
    return !signal.aborted && !this.#closed && !this.#pending && session === this.#session &&
      grant?.verificationRef === this.#current.verificationRef && grant.expiresAt === this.#current.expiresAt ? grant : undefined;
  }

  dispose(): void {
    this.#closed = true; this.#session.dispose();
    this.#lifetime.removeEventListener("abort", this.#onClose);
  }
}
