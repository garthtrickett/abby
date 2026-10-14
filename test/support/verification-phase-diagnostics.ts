import type { TestContext } from "node:test";
import { CallerVerificationSession } from "../../src/standalone/caller-verification-session.ts";
import { EmailPatientAuthority } from "../../src/standalone/email-patient-authority.ts";
import { ClinikoRepresentativeSelection } from "../../src/standalone/cliniko-representative-selection.ts";
import { ClinikoBookingOffers } from "../../src/standalone/cliniko-booking-offers.ts";
import { ClinikoReschedulingAuthority } from "../../src/standalone/cliniko-rescheduling-authority.ts";

/** Failure-only fixture diagnostics. Preserve every result, signal and native
 * read; record phase/timing/booleans rather than identity, recipient or code. */
export function verificationPhaseDiagnostics(context: TestContext, actor: CallerVerificationSession,
  actorPatientRef: string, representative: ClinikoRepresentativeSelection) {
  const records: { phase: string; ms: number; passed: boolean; aborted: boolean }[] = [];
  const record = (phase: string, at: number, passed: boolean, signal?: AbortSignal) => {
    records.push({ phase, ms: Date.now() - at, passed, aborted: signal?.aborted === true });
    if (records.length > 80) records.shift();
  };
  const verified = CallerVerificationSession.prototype.verified;
  context.mock.method(CallerVerificationSession.prototype, "verified", async function(this: CallerVerificationSession, ...args: Parameters<typeof verified>) {
    const at = Date.now(), result = await verified.apply(this, args);
    record(this === actor ? "actor-proof" : "subject-proof", at, !!result, args[0]); return result;
  });
  const revalidate = EmailPatientAuthority.prototype.revalidate;
  context.mock.method(EmailPatientAuthority.prototype, "revalidate", async function(this: EmailPatientAuthority, ...args: Parameters<typeof revalidate>) {
    const at = Date.now(), result = await revalidate.apply(this, args);
    record(args[0].patientId === actorPatientRef ? "actor-channel" : "subject-channel", at, result, args[0].signal); return result;
  });
  const ownership = CallerVerificationSession.prototype.ownsCurrentProof;
  context.mock.method(CallerVerificationSession.prototype, "ownsCurrentProof", async function(this: CallerVerificationSession, ...args: Parameters<typeof ownership>) {
    const at = Date.now(), result = await ownership.apply(this, args);
    record(this === actor ? "actor-ownership" : "subject-ownership", at, result, args[2]); return result;
  });
  const recipient = representative.registeredRecipient;
  context.mock.method(representative, "registeredRecipient", async function(this: ClinikoRepresentativeSelection, ...args: Parameters<typeof recipient>) {
    const at = Date.now(), result = await recipient.apply(this, args);
    record("subject-recipient", at, result.ok, args[3]); return result;
  });
  const offer = ClinikoBookingOffers.prototype.resolve;
  context.mock.method(ClinikoBookingOffers.prototype, "resolve", async function(this: ClinikoBookingOffers, ...args: Parameters<typeof offer>) {
    const at = Date.now(), result = await offer.apply(this, args);
    record("native-offer", at, result.ok, args[0].signal); return result;
  });
  const target = ClinikoReschedulingAuthority.prototype.resolveTarget;
  context.mock.method(ClinikoReschedulingAuthority.prototype, "resolveTarget", async function(this: ClinikoReschedulingAuthority, ...args: Parameters<typeof target>) {
    const at = Date.now(), result = await target.apply(this, args);
    record("native-target", at, result.ok, args[0].signal); return result;
  });
  const preference = ClinikoReschedulingAuthority.prototype.preferOriginalPractitioner;
  context.mock.method(ClinikoReschedulingAuthority.prototype, "preferOriginalPractitioner", async function(this: ClinikoReschedulingAuthority, ...args: Parameters<typeof preference>) {
    const at = Date.now(), result = await preference.apply(this, args);
    record("native-practitioner", at, result, args[0].signal); return result;
  });
  return () => JSON.stringify(records.slice(-24));
}
