import { ClinikoRepresentativeContactReader } from "../cliniko/representative-contact.ts";
import type { RepresentativeRegisteredRecipient } from "../cliniko/representative-contact.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import type { LocationScope } from "../core/model.ts";
import { err, ok } from "../core/model.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";
import type { ClinikoBookingSessionConfig } from "./cliniko-booking-session.ts";
import type { PatientVerificationPermission } from "./email-patient-authority.ts";
import { OwnerFileCallerPolicy } from "./owner-file-caller-policy.ts";
import type { PatientOperation, VerificationPolicyGate } from "./transient-patient-proof.ts";

export type AdditionalRepresentativeVerification = Readonly<{
  policy: VerificationPolicyGate & Readonly<{ operation: PatientOperation }>; permission: PatientVerificationPermission;
}>;
type Config = Omit<ClinikoBookingSessionConfig, "callerApprovalPath" | "bookingApprovalPath" | "permission" | "representative"> & Readonly<{
  patientId: string; operation: PatientOperation; subjectApprovalPath: string;
  contactAuthority?: RepresentativeRegisteredRecipient;
  /** The concrete selection still owns native identity/age/current actor and
   * independent clinic authority. These hooks expose no model/caller route. */
  authority: Readonly<{
    authorized(signal: AbortSignal): Promise<boolean>;
    current(purpose: "channel" | "operation", signal: AbortSignal): Promise<string | undefined>;
    operation(signal: AbortSignal): Promise<boolean>;
  }>;
  additional?: AdditionalRepresentativeVerification;
}>;

/** Shared selected-patient proof transaction for both concrete representative
 * sources. Actor proofs never enter this verifier. A channel read is consumed
 * once by the same permission transaction; later validations read it afresh. */
export async function createRepresentativeSubjectVerifier(c: Config, signal: AbortSignal) {
  if (signal.aborted) return err({ kind: "verificationUnavailable" as const });
  const caller = await OwnerFileCallerPolicy.capture({ path: c.subjectApprovalPath, scope: c.receipt.scope, policyVersion: c.policyVersion,
    operation: c.operation, directory: c.directory, clock: c.clock ?? (() => new Date().toISOString()) });
  if (!caller.ok || !await caller.value.allowsRepresentative(c.receipt.scope) || signal.aborted) return err({ kind: "verificationUnavailable" as const });
  const channels = new WeakSet<AbortSignal>(), scopeMatches = (scope: LocationScope) => sameScope(scope, c.receipt.scope);
  const policy = { operation: c.operation, current: async (scope: LocationScope) => {
    const read = await caller.value.current(scope), extra = c.additional ? await c.additional.policy.current(scope) : undefined;
    return read.ok ? ok({ ...read.value, enabled: read.value.enabled && (!c.additional || !!extra?.ok && extra.value.enabled &&
      sameScope(extra.value.scope, scope) && extra.value.version === c.policyVersion) && await caller.value.allowsRepresentative(scope) &&
      await c.authority.authorized(c.signal) }) : read;
  } };
  const permission: PatientVerificationPermission = { allows: async (scope, id, operation, version, request) => {
    const channel = channels.has(request); channels.delete(request);
    if (!scopeMatches(scope) || id !== c.patientId || operation !== c.operation || version !== c.policyVersion || request.aborted ||
        c.additional && await c.additional.permission.allows(scope, id, operation, version, request) !== true) return false;
    if (!channel) return !!await c.authority.current("operation", request);
    return await c.authority.authorized(request) && !request.aborted && await c.authority.operation(request) && !request.aborted;
  } };
  const fingerprint = clinikoCredentialFingerprint(c.cliniko.apiKey);
  const contact = new ClinikoRepresentativeContactReader({ ...c.cliniko, scope: c.receipt.scope }, {
    matchesContact: (scope, account) => scope.tenantId === c.receipt.scope.tenantId && scope.clinicId === c.receipt.scope.clinicId && account === fingerprint &&
      (!c.contactAuthority || c.contactAuthority.matchesContact(scope, account)),
    registeredRecipient: async (scope, id, phone, request) => {
      channels.delete(request);
      if (!scopeMatches(scope) || id !== c.patientId || phone !== c.inbound.presentedCallerNumber || request.aborted) return err({ kind: "denied" });
      if (c.contactAuthority) {
        // Preserve the native selector's registered-channel entry point, also
        // used by existing phase diagnostics. The transaction still consumes
        // this successful channel read only once below.
        const read = await c.contactAuthority.registeredRecipient(scope, id, phone, request);
        if (!read.ok || request.aborted) return err({ kind: "denied" });
        channels.add(request); return read;
      }
      const email = await c.authority.current("channel", request);
      if (!email || request.aborted) return err({ kind: "denied" });
      channels.add(request); return ok(email);
    },
  }, c.fetchPort);
  const created = CallerVerificationSession.create({ ...c, policyStore: c.policies, policy, permission, contact, budget: c.verificationBudget,
    lookup: { candidates: async scope => scope.tenantId === c.receipt.scope.tenantId && scope.clinicId === c.receipt.scope.clinicId &&
      await c.authority.authorized(c.signal) ? ok({ kind: "one", candidateIds: [c.patientId] }) : err({ kind: "denied" }) } });
  if (signal.aborted) { if (created.ok) created.value.dispose(); return err({ kind: "verificationUnavailable" as const }); }
  return created;
}
