import { ClinikoAppointmentReader } from "../cliniko/appointments.ts";
import type { ClinikoAppointmentConfig } from "../cliniko/appointments.ts";
import type { AppointmentHost } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { AdmissionReceipt, AppointmentReadFailure, Result } from "../core/model.ts";
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
  readonly appointments: AppointmentHost;

  private constructor(proof: TransientPatientProofHost, appointments: ClinikoAppointmentReader) {
    this.#proof = proof;
    this.appointments = appointments;
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
    return ok(new VerifiedAppointmentReadSession(proof, reader.value));
  }

  /** Only a trusted call owner may pass a host-issued verification token. */
  issueReadProof(token: VerificationToken): Promise<Result<Readonly<{
    verificationRef: string; expiresAt: string;
  }>, VerificationFailure>> {
    return this.#proof.issue(token, "appointments.read");
  }

  dispose(): void { this.#proof.dispose(); }
}
