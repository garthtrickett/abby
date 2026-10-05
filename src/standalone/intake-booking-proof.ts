import { randomBytes } from "node:crypto";
import { ClinikoVerificationContactReader } from "../cliniko/verification-contact.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope } from "../core/model.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { ClinikoIntakeSession } from "./cliniko-intake-session.ts";
import type { PatientVerificationPermission } from "./email-patient-authority.ts";
import { TransientPatientProofHost } from "./transient-patient-proof.ts";
import type { PatientAuthorityRecheck, PatientAuthorityRequest, VerificationPolicyGate } from "./transient-patient-proof.ts";

type Config = Readonly<{
  intake: ClinikoIntakeSession; scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  presentedCallerNumber: string; contact: ClinikoVerificationContactReader; permission: PatientVerificationPermission;
  policy: VerificationPolicyGate; signal: AbortSignal; clock: () => string; timeoutMs?: number;
}>;

/** The only candidate is this owner's proven creation. No phone-index match, spoken ID or new mailbox challenge.
 * Independent book permission and fresh Cliniko contact are checked on every protected use. */
export class IntakeBookingProof {
  readonly proof: TransientPatientProofHost;
  readonly #config: Config;
  readonly #lifetime = new AbortController();
  readonly #onClose = () => this.dispose();
  #token: string | undefined;
  #grant: Readonly<{ verificationRef: string; expiresAt: string }> | undefined;
  #issuing = false;
  constructor(config: Config) {
    if (!(config.intake instanceof ClinikoIntakeSession) || !config.intake.matchesCall(config.scope, config.callId, config.sessionId, config.policyVersion) ||
        !(config.contact instanceof ClinikoVerificationContactReader) || typeof config.permission?.allows !== "function" || config.signal.aborted) {
      throw new TypeError("invalid intake booking proof configuration");
    }
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
    this.proof = new TransientPatientProofHost({ ...config, maxAttempts: 1,
      lookup: { candidates: async (scope, phone) => {
        if ((scope.tenantId !== config.scope.tenantId || scope.clinicId !== config.scope.clinicId) || phone !== config.presentedCallerNumber || this.#lifetime.signal.aborted) return err({ kind: "unavailable" });
        const source = await config.intake.createdPatient(this.#lifetime.signal);
        return source && source.phone === phone ? ok({ kind: "one", candidateIds: [source.patientId] }) : ok({ kind: "none", candidateIds: [] });
      } },
      authority: {
        attest: async request => {
          const token = this.#token; this.#token = undefined;
          if (!token || request.token !== token) return err({ kind: "denied" });
          const source = await this.#current(request);
          return source && request.candidateIds.length === 1 && request.candidateIds[0] === source.patientId ?
            ok({ scope: config.scope, callId: config.callId, sessionId: config.sessionId, policyVersion: config.policyVersion,
              patientId: source.patientId, operations: ["appointments.book"], expiresAt: source.expiresAt }) : err({ kind: "denied" });
        },
        revalidate: async request => (await this.#current(request))?.patientId === request.patientId,
      } });
    config.signal.addEventListener("abort", this.#onClose, { once: true });
    if (config.signal.aborted) this.dispose();
  }
  async #current(request: PatientAuthorityRequest | PatientAuthorityRecheck) {
    const config = this.#config, signal = AbortSignal.any([request.signal, this.#lifetime.signal, config.signal]);
    if (signal.aborted || !sameScope(request.scope, config.scope) || request.callId !== config.callId ||
        request.sessionId !== config.sessionId || request.policyVersion !== config.policyVersion || request.operation !== "appointments.book") return undefined;
    const source = await config.intake.createdPatient(signal);
    if (!source || source.phone !== config.presentedCallerNumber || Date.parse(source.expiresAt) <= Date.parse(config.clock()) + 120_000) return undefined;
    const contact = await config.contact.read(config.scope, source.patientId, source.phone, signal);
    if (!contact.ok || contact.value !== source.email || signal.aborted ||
        await config.permission.allows(config.scope, source.patientId, "appointments.book", config.policyVersion, signal) !== true) return undefined;
    const fresh = await config.intake.createdPatient(signal);
    return !signal.aborted && fresh && fresh.patientId === source.patientId && fresh.email === source.email && fresh.phone === source.phone &&
      fresh.expiresAt === source.expiresAt && Date.parse(fresh.expiresAt) > Date.parse(config.clock()) + 120_000 ? fresh : undefined;
  }
  /** Private grant consumed only by the concrete booking menu/host. Concurrent reads never mint another grant. */
  async verified(external?: AbortSignal): Promise<Readonly<{ verificationRef: string; expiresAt: string }> | undefined> {
    if (this.#lifetime.signal.aborted || external?.aborted || this.#issuing) return undefined;
    const signal = AbortSignal.any([this.#lifetime.signal, this.#config.signal, ...(external ? [external] : [])]);
    if (!this.#grant) {
      if (!await this.#config.intake.createdPatient(signal) || signal.aborted || this.#issuing) return undefined;
      this.#issuing = true; this.#token = randomBytes(32).toString("base64url");
      const abort = () => this.proof.revoke(); signal.addEventListener("abort", abort, { once: true });
      try {
        const issued = await this.proof.issue(this.#token, "appointments.book");
        if (!issued.ok || signal.aborted) return undefined;
        this.#grant = issued.value;
      } finally { this.#issuing = false; this.#token = undefined; signal.removeEventListener("abort", abort); }
    }
    const checked = await this.proof.verifyOperation(this.#config.scope, this.#grant.verificationRef, "appointments.book", this.#config.clock(), signal);
    return checked.ok && !signal.aborted ? { ...this.#grant } : undefined;
  }
  dispose(): void {
    this.#lifetime.abort(); this.#config.signal.removeEventListener("abort", this.#onClose); this.proof.dispose();
    this.#token = undefined; this.#grant = undefined;
  }
}
