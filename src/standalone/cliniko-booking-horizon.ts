import type { BookingHorizonQuery } from "../core/host.ts";
import type { BookingHorizonRead } from "../core/booking-horizon.ts";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { OwnerFileBookingPolicy } from "./owner-file-booking-policy.ts";
import { OwnerFileReschedulingPolicy } from "./owner-file-rescheduling-policy.ts";
import { OwnerFileBookingCatalogue } from "./owner-file-booking-catalogue.ts";
import type { ClinikoCallFlowConfig } from "./cliniko-call-flow.ts";
import { normalizedSpokenName } from "../core/pending-location.ts";
import { clinicDayStartUtc } from "./clinic-clock.ts";

type Config = Pick<ClinikoCallFlowConfig, "receipt" | "sessionId" | "policyVersion" | "ledger" | "policies" | "cliniko" | "approvals" | "catalogue" | "directory" | "clock">;
const unavailable = (): Result<BookingHorizonRead, Readonly<{ kind: "bookingHorizonUnavailable" }>> => err({ kind: "bookingHorizonUnavailable" });

/** Read only exact current public approvals and admin membership. Never read a
 * patient/contact/provider, create a verifier or infer an available time. */
export async function readClinikoBookingHorizon(c: Config, query: BookingHorizonQuery, operation: "book" | "reschedule", practitioner?: string): Promise<Result<BookingHorizonRead, Readonly<{ kind: "bookingHorizonUnavailable" }>>> {
  const signal = query.signal, clock = c.clock ?? (() => new Date().toISOString());
  try {
    if (signal.aborted || !sameScope(query.scope, c.receipt.scope) || query.callId !== c.receipt.callId || query.sessionId !== c.sessionId || query.policyVersion !== c.policyVersion) return unavailable();
    const active = async () => {
      const state = await c.ledger.read(query.callId, query.scope), policy = await c.policies.read(query.scope), at = Date.parse(clock());
      return state.ok && policy.ok && Number.isFinite(at) && !signal.aborted && !state.value.callerIdentityDenied &&
        state.value.lifecycle === "active" && state.value.sessionLease?.sessionId === c.sessionId && Date.parse(state.value.sessionLease.expiresAt) > at &&
        state.value.conversationRevision === query.expectedConversationRevision && state.value.policy.policyVersion === c.policyVersion && policy.value.policyVersion === c.policyVersion &&
        state.value.policy.automationEnabled && policy.value.automationEnabled && state.value.policy.capabilities[operation] === "execute" && policy.value.capabilities[operation] === "execute" &&
        (operation === "book" ? state.value.policy.bookingEnabled === true && policy.value.bookingEnabled === true : state.value.policy.reschedulingEnabled === true && policy.value.reschedulingEnabled === true) ? state.value : undefined;
    };
    const result = await awaitUntilAbort((async () => {
      if (!await active()) return undefined;
      const binding = { scope: c.receipt.scope, policyVersion: c.policyVersion, businessId: c.cliniko.businessId,
        practitionerId: c.cliniko.practitionerId, appointmentTypeId: c.cliniko.appointmentTypeId,
        recallTypeId: c.cliniko.recallTypeId, timeZone: c.cliniko.timeZone,
        credentialFingerprint: clinikoCredentialFingerprint(c.cliniko.apiKey), directory: c.directory, clock };
      const fees = operation === "reschedule" ? await OwnerFileReschedulingPolicy.capture({ ...binding, path: c.approvals.rescheduling }) : undefined;
      if (operation === "reschedule" && !fees?.ok) return undefined;
      const catalogue = operation === "book" && c.catalogue ? await OwnerFileBookingCatalogue.capture({ ...binding, path: c.catalogue.approvalPath }) : undefined;
      const profile = catalogue?.ok ? await catalogue.value.current(query.scope) : undefined;
      if (operation === "book" && c.catalogue && (!profile?.ok || profile.value.practitioners.length !== c.catalogue.practitioners.length ||
          profile.value.practitioners.some((member, index) => member.practitionerId !== c.catalogue!.practitioners[index]?.practitionerId) ||
          c.catalogue.practitioners[0]?.practitionerId !== c.cliniko.practitionerId || c.catalogue.practitioners[0]?.bookingApprovalPath !== c.approvals.booking)) return undefined;
      const all = profile?.ok ? profile.value.practitioners.map((member, index) => ({ ...member, path: c.catalogue!.practitioners[index]!.bookingApprovalPath })) :
        [{ practitionerId: c.cliniko.practitionerId, name: null, path: c.approvals.booking }];
      const members = practitioner === "any" ? all : practitioner && profile?.ok ? all.filter(member => normalizedSpokenName(member.name) === normalizedSpokenName(practitioner)) : [all[0]!];
      if (!members.length) return undefined;
      // These are independent public policies; no shared patient verifier IO.
      const captured = await Promise.all(members.map(async member => {
        const policy = await OwnerFileBookingPolicy.capture({ ...binding, path: member.path, practitionerId: member.practitionerId });
        const value = policy.ok ? await policy.value.current(query.scope) : undefined;
        return policy.ok && value?.ok ? { policy: policy.value, value: value.value, name: member.name } : undefined;
      }));
      if (captured.some(item => !item) || signal.aborted) return undefined;
      const fee = fees?.ok ? await fees.value.current(query.scope) : undefined;
      if (operation === "reschedule" && !fee?.ok) return undefined;
      for (const item of captured) {
        const current = item && await item.policy.current(query.scope);
        if (!current?.ok || JSON.stringify(current.value) !== JSON.stringify(item!.value)) return undefined;
      }
      const finalFees = fees?.ok ? await fees.value.current(query.scope) : undefined;
      const finalProfile = catalogue?.ok ? await catalogue.value.current(query.scope) : undefined;
      if (fees && (!finalFees?.ok || !fee?.ok || JSON.stringify(finalFees.value) !== JSON.stringify(fee.value)) ||
          catalogue && (!finalProfile?.ok || !profile?.ok || JSON.stringify(finalProfile.value) !== JSON.stringify(profile.value))) return undefined;
      const state = await active(); if (!state || signal.aborted) return undefined;
      const observedAt = clock(), at = Date.parse(observedAt);
      const expires = Math.min(Date.parse(state.sessionLease!.expiresAt), ...captured.map(item => Date.parse(item!.value.effectiveUntil)),
        fee?.ok ? Date.parse(fee.value.effectiveUntil) : Infinity, profile?.ok ? Date.parse(profile.value.effectiveUntil) : Infinity);
      if (!Number.isFinite(at) || !Number.isFinite(expires) || expires <= at) return undefined;
      return { scope: { ...query.scope }, callId: query.callId, sessionId: query.sessionId, policyVersion: query.policyVersion,
        operation, observedAt, expiresAt: new Date(expires).toISOString(), bounds: captured.map(item => ({ practitionerName: item!.name,
          // The move policy horizon concerns the existing target's eligibility,
          // not destination start times. Destination approval owns these bounds.
          minNoticeMinutes: item!.value.minNoticeMinutes, maxAdvanceDays: item!.value.maxAdvanceDays })) };
    })(), signal);
    return result && !signal.aborted ? ok(result) : unavailable();
  } catch { return unavailable(); }
}

/** Whole requested calendar range is outside every selected member's rolling
 * start-time bounds. A partial day/range is left to the ordinary offer filter. */
export function requestedDatesOutsideHorizon(read: BookingHorizonRead, from: string, to: string, timeZone: string): boolean {
  try {
    const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
    if (!date(from) || !date(to) || to < from) return false;
    const first = Date.parse(clinicDayStartUtc(timeZone, from));
    const following = new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    const last = Date.parse(clinicDayStartUtc(timeZone, following)) - 1, at = Date.parse(read.observedAt);
    return Number.isFinite(first) && Number.isFinite(last) && Number.isFinite(at) && read.bounds.length > 0 && read.bounds.every(bound =>
      first > at + bound.maxAdvanceDays * 86_400_000 || last < at + bound.minNoticeMinutes * 60_000);
  } catch { return false; }
}
