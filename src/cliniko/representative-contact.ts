import { err } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { ClinikoPatientConfig } from "./patients.ts";
import { ClinikoVerificationContactReader } from "./verification-contact.ts";
import type { VerificationContactFailure } from "./verification-contact.ts";
import { clinikoCredentialFingerprint } from "./read-budget.ts";

/** Private clinic authority seam. The concrete representative selector owns the
 * verified actor, exact native relationship/subject and current independent permission. */
export interface RepresentativeRegisteredRecipient {
  matchesContact(scope: Pick<LocationScope, "tenantId" | "clinicId">, fingerprint: string): boolean;
  registeredRecipient(scope: LocationScope, patientId: string, phone: string, signal: AbortSignal): Promise<Result<string, VerificationContactFailure>>;
}
/** A representative never changes the subject's phone record to make self lookup succeed. */
export class ClinikoRepresentativeContactReader extends ClinikoVerificationContactReader {
  readonly #authority: RepresentativeRegisteredRecipient;
  constructor(config: ClinikoPatientConfig & Readonly<{ countryCallingCode: string }>, authority: RepresentativeRegisteredRecipient, fetchPort: typeof fetch = fetch) {
    super(config, fetchPort);
    if (!authority || typeof authority.registeredRecipient !== "function" ||
        !authority.matchesContact(config.scope, clinikoCredentialFingerprint(config.apiKey))) throw new TypeError("representative contact authority mismatch");
    this.#authority = authority;
  }
  override read(scope: LocationScope, patientId: string, phone: string, signal: AbortSignal) {
    return signal.aborted ? Promise.resolve(err({ kind: "denied" as const })) : this.#authority.registeredRecipient(scope, patientId, phone, signal);
  }
}
