import { ClinikoAppointmentReader } from "../cliniko/appointments.ts";
import type { ClinikoAppointmentConfig } from "../cliniko/appointments.ts";
import type { AppointmentHost } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { AdmissionReceipt, AppointmentRead, AppointmentReadFailure, LocationScope, Result } from "../core/model.ts";
import { callIdFor } from "../voice/admission.ts";
import type { AuthenticatedInboundCall } from "../voice/admission.ts";
import { TransientPatientProofHost } from "./transient-patient-proof.ts";
import type { TransientPatientProofConfig, VerificationFailure, VerificationToken } from "./transient-patient-proof.ts";

export type VerifiedAppointmentReadConfig = Omit<TransientPatientProofConfig, "scope" | "callId" | "presentedCallerNumber"> & Readonly<{
  receipt: AdmissionReceipt;
  inbound: AuthenticatedInboundCall;
  cliniko: Omit<ClinikoAppointmentConfig, "scope">;
  fetchPort?: typeof fetch;
}>;

/** One call's verified read capability. The live runner does not construct this until a clinic verification flow exists. */
export class VerifiedAppointmentReadSession {
  readonly #proof: TransientPatientProofHost;
  readonly #reader: ClinikoAppointmentReader;
  readonly #scope: LocationScope;
  readonly appointments: AppointmentHost;
  #choices: Readonly<{ verificationRef: string; from: string; to: string; sourceRef: string;
    options: AppointmentRead["appointments"] }> | undefined;
  #closed = false;

  private constructor(proof: TransientPatientProofHost, reader: ClinikoAppointmentReader, scope: LocationScope) {
    this.#proof = proof;
    this.#reader = reader;
    this.#scope = structuredClone(scope);
    this.appointments = Object.freeze({
      list: (readScope: LocationScope, verificationRef: string, from: string, to: string, now: string) =>
        this.#list(readScope, verificationRef, from, to, now),
      select: (readScope: LocationScope, verificationRef: string, choice: 1 | 2 | 3, now: string) =>
        this.#select(readScope, verificationRef, choice, now),
    });
  }

  static create(config: VerifiedAppointmentReadConfig): Result<VerifiedAppointmentReadSession, AppointmentReadFailure> {
    let proof: TransientPatientProofHost;
    try {
      const receipt = config.receipt;
      const inbound = config.inbound;
      if (!receipt?.scope || (receipt.lifecycle !== "starting" && receipt.lifecycle !== "active") ||
          !inbound?.key?.accountRef || !inbound.key.providerCallRef ||
          receipt.callId !== callIdFor(inbound.key) ||
          receipt.admission.key.accountRef !== inbound.key.accountRef ||
          receipt.admission.key.providerCallRef !== inbound.key.providerCallRef ||
          receipt.admission.dialedNumber !== inbound.dialedNumber) return err({ kind: "invalidConfig" });
      proof = new TransientPatientProofHost({ ...config, scope: receipt.scope, callId: receipt.callId,
        presentedCallerNumber: config.inbound.presentedCallerNumber });
    } catch {
      return err({ kind: "invalidConfig" });
    }
    const reader = ClinikoAppointmentReader.create({ ...config.cliniko, scope: config.receipt.scope }, proof,
      config.fetchPort, config.clock);
    if (!reader.ok) {
      proof.dispose();
      return reader;
    }
    return ok(new VerifiedAppointmentReadSession(proof, reader.value, config.receipt.scope));
  }

  async #stillVerified(scope: LocationScope, verificationRef: string, now: string):
    Promise<Result<void, AppointmentReadFailure>> {
    try {
      const checked = await this.#proof.verifyPatient(scope, verificationRef, now);
      if (this.#closed) return err({ kind: "invalidProof" });
      if (!checked.ok) return err({ kind: checked.error.kind === "unavailable" ? "unavailable" : "invalidProof" });
      return ok(undefined);
    } catch { return err({ kind: "unavailable" }); }
  }

  async #list(scope: LocationScope, verificationRef: string, from: string, to: string, now: string):
    Promise<Result<AppointmentRead, AppointmentReadFailure>> {
    this.#choices = undefined;
    if (this.#closed) return err({ kind: "invalidProof" });
    const read = await this.#reader.list(scope, verificationRef, from, to, now);
    if (!read.ok || this.#closed) return this.#closed ? err({ kind: "invalidProof" }) : read;
    const finalProof = await this.#stillVerified(scope, verificationRef, now);
    if (!finalProof.ok) return finalProof;
    const options = [...read.value.appointments].sort((left, right) =>
      left.startsAt.localeCompare(right.startsAt));
    if (new Set(options.map(option => option.startsAt)).size !== options.length) {
      return err({ kind: "unavailable" });
    }
    if (options.length > 1) this.#choices = { verificationRef, from, to, sourceRef: read.value.sourceRef,
      options: options.slice(0, 3) };
    return read;
  }

  async #select(scope: LocationScope, verificationRef: string, choice: 1 | 2 | 3, now: string):
    Promise<Result<Readonly<{ snapshot: AppointmentRead; from: string; to: string }>, AppointmentReadFailure>> {
    const prior = this.#choices;
    this.#choices = undefined;
    if (this.#closed || scope.tenantId !== this.#scope.tenantId || scope.clinicId !== this.#scope.clinicId ||
        scope.locationId !== this.#scope.locationId || !prior || prior.verificationRef !== verificationRef ||
        ![1, 2, 3].includes(choice) || !prior.options[choice - 1]) return err({ kind: "notFound" });
    const target = prior.options[choice - 1]!;
    const nowMs = Date.parse(now);
    const fromMs = Date.parse(prior.from);
    const toMs = Date.parse(prior.to);
    if (!Number.isFinite(nowMs) || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || nowMs >= toMs) {
      return err({ kind: "invalidRange" });
    }
    const freshFrom = new Date(Math.max(nowMs, fromMs)).toISOString();
    const fresh = await this.#reader.list(scope, verificationRef, freshFrom, prior.to, now);
    if (this.#closed) return err({ kind: "invalidProof" });
    if (!fresh.ok) return fresh;
    const finalProof = await this.#stillVerified(scope, verificationRef, now);
    if (!finalProof.ok) return finalProof;
    const matching = fresh.value.appointments.filter(item => item.appointmentRef === target.appointmentRef);
    if (fresh.value.sourceRef !== prior.sourceRef || matching.length !== 1 ||
        matching[0]!.startsAt !== target.startsAt || matching[0]!.endsAt !== target.endsAt) {
      return err({ kind: "notFound" });
    }
    return ok({ snapshot: { ...fresh.value, appointments: matching }, from: freshFrom, to: prior.to });
  }

  /** Only a trusted call owner may pass a host-issued verification token. */
  issueReadProof(token: VerificationToken): Promise<Result<Readonly<{
    verificationRef: string; expiresAt: string;
  }>, VerificationFailure>> {
    return this.#proof.issue(token, "appointments.read");
  }

  dispose(): void {
    this.#closed = true;
    this.#choices = undefined;
    this.#proof.dispose();
  }
}
