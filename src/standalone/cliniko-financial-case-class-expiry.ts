import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { ClinikoClassAttendanceWriter } from "../cliniko/class-attendance-write.ts";
import type { ClinikoAttendanceRequest } from "../cliniko/class-attendance-write.ts";
import { ClinikoPatientCaseSessionsReader } from "../cliniko/patient-case-sessions.ts";
import type { ClinikoCaseAttendance } from "../cliniko/patient-case-sessions.ts";
import type { FinancialRecordAuthority } from "../cliniko/financial-record-retention.ts";
import { checkClinikoHeadroom } from "../cliniko/read-budget.ts";
import { OwnerFileClassPolicy } from "./owner-file-class-policy.ts";
import { approvalRef } from "./owner-file-clinic-approval.ts";
import { sameScope } from "./appointment-change-authority.ts";
import type { ClassPassCancellationEffect } from "./cliniko-class-pass-cancellation.ts";
import type { FinancialEffectBarrier } from "./financial-effect-barrier.ts";
import type { FinancialLifecycleBinding } from "./financial-lifecycle-sources.ts";
import { financialClinicalNativeRead } from "./financial-clinical-native-read.ts";
import { readFinancialClinicalClassTarget, currentFinancialClassPolicy } from "./financial-clinical-class-target.ts";
import type { FinancialClinicalClassTarget } from "./financial-clinical-class-target.ts";
import { FinancialClinicalExpiryProtocol, FinancialClinicalExpiryRefusal } from "./financial-clinical-expiry-protocol.ts";
import type { FinancialExpiryQuery, FinancialExpiryAuthority, FinancialExpiryApproval,
  FinancialClinicalExpiryConfig, FinancialClinicalExpiryOutcome, FinancialClinicalExpiryFailure } from "./financial-clinical-expiry-protocol.ts";

type Cancellation = Extract<ClinikoAttendanceRequest, { kind: "cancel" }>;
type Case = Pick<ClinikoCaseAttendance, "patientCaseId" | "maximum" | "used" | "usageFingerprint" | "includeCancelled" | "includeDna" | "associationCount" | "eligibleOnSessionDate"> &
  Readonly<{ effect: ClassPassCancellationEffect }>;
export type FinancialCaseClassTarget = FinancialClinicalClassTarget & Readonly<{ patientCase: Case }>;
export type FinancialCaseClassApproval = FinancialExpiryApproval & Readonly<{
  kind: "cancelUnpaidCaseClass"; classPolicyVersion: string; caseTermsVersion: string; approvedCaseTerms: string;
  patientCaseId: string; entitlementRef: string; caseEffect: ClassPassCancellationEffect; cancellationReason: Cancellation["cancellationReason"];
}>;
export type FinancialCaseClassExpiryQuery = FinancialExpiryQuery<FinancialCaseClassTarget>;
export type FinancialCaseClassExpiryAuthority = FinancialExpiryAuthority<FinancialCaseClassTarget, FinancialCaseClassApproval>;
export type FinancialCaseClassExpiryConfig = FinancialClinicalExpiryConfig & Readonly<{
  classPolicy: OwnerFileClassPolicy;
  /** Reviewed bound for all additional native authority calls in one operation.
   * Every actual call must still claim the same physical account budget. */
  maximumAuthorityRequests: number;
}>;
type Request = Readonly<{ cancellation: Cancellation; target: FinancialCaseClassTarget }>;
const refuse = (kind: "forbidden" | "mismatched" = "forbidden"): never => { throw new FinancialClinicalExpiryRefusal(kind); };
const effectOf = (read: ClinikoCaseAttendance): ClassPassCancellationEffect => {
  const delta = Number(read.includeCancelled) - Number(read.attendance.countsSession);
  return delta < 0 ? "releaseOne" : delta > 0 ? "consumeOne" : "unchanged";
};

/** Exact current case cancellation, independently approved for its native
 * counter consequence. Matching case IDs are not immutable history or money.
 * A verified cancellation can still require separate case-effect review. */
export class ClinikoFinancialCaseClassExpiryOwner {
  readonly #protocol: FinancialClinicalExpiryProtocol<FinancialCaseClassTarget, FinancialCaseClassApproval, Request>;
  private constructor(protocol: FinancialClinicalExpiryProtocol<FinancialCaseClassTarget, FinancialCaseClassApproval, Request>) { this.#protocol = protocol; }
  static create(config: FinancialCaseClassExpiryConfig, authority: FinancialCaseClassExpiryAuthority, records: FinancialRecordAuthority,
    barrier: FinancialEffectBarrier, native: typeof fetch = fetch, stripe: typeof fetch = fetch): Result<ClinikoFinancialCaseClassExpiryOwner, FinancialClinicalExpiryFailure> {
    try {
      if (!(config.classPolicy instanceof OwnerFileClassPolicy) || !Number.isSafeInteger(config.maximumAuthorityRequests) ||
          config.maximumAuthorityRequests < 0 || config.maximumAuthorityRequests > 180) return err({ kind: "invalidConfig" });
      config = Object.freeze({ ...config, cliniko: Object.freeze({ ...config.cliniko }), stripe: Object.freeze({ ...config.stripe }) });
      const binding = config.classPolicy.binding();
      if (!sameScope(binding.scope, config.cliniko.scope) || binding.businessId !== config.cliniko.businessId) return err({ kind: "invalidConfig" });
      const nativeConfig = { ...config.cliniko, practitionerId: binding.practitionerId, appointmentTypeId: binding.appointmentTypeId };
      const clock = config.cliniko.clock ?? (() => new Date().toISOString()), writer = ClinikoClassAttendanceWriter.create(nativeConfig, native);
      if (!writer.ok) return err({ kind: "invalidConfig" });
      const currentPolicy = (target: FinancialClinicalClassTarget, signal: AbortSignal) => currentFinancialClassPolicy(config.classPolicy, target, signal);
      const caseReader = (target: FinancialClinicalClassTarget, patientCaseId: string, signal: AbortSignal, permit: (signal: AbortSignal) => Promise<boolean>) => {
        const capability = financialClinicalNativeRead({ scope: target.scope, patientId: target.patientId, signal, clock,
          current: async stop => await permit(stop) && await currentPolicy(target, stop) });
        const reader = ClinikoPatientCaseSessionsReader.create({ ...nativeConfig, timeZone: target.policy.timeZone,
          attendanceStatus: "arrivedFalseIsDna" }, capability.proof, { allows: async q => q.patientId === target.patientId &&
            q.patientCaseId === patientCaseId && q.classSessionId === target.sessionId && q.startsAt === target.startsAt &&
            await permit(q.signal) && await currentPolicy(target, q.signal) }, native, clock);
        if (!reader.ok) return refuse();
        return { reader: reader.value, query: () => ({ scope: target.scope, verificationRef: capability.reference, patientCaseId,
          classSessionId: target.sessionId, startsAt: target.startsAt, now: clock() }) };
      };
      const protocol = FinancialClinicalExpiryProtocol.create<FinancialCaseClassTarget, FinancialCaseClassApproval, Request>(config, authority, records, barrier, native, stripe, {
        async read(sources, op, permit) {
          const originalCase = sources.booking.observation.classCreationRequest?.patientCaseId;
          if (!originalCase) return refuse();
          const target = await readFinancialClinicalClassTarget({ cliniko: nativeConfig, classPolicy: config.classPolicy, clock, native }, sources, op, permit, "nativeCaseSessions");
          if (!target.policy.caseSessions?.cancellation) return refuse();
          const exact = await op.wait(writer.value.inspect({ kind: "book", scope: target.scope, patientId: target.patientId, sessionId: target.sessionId,
            actionId: target.creationActionId, patientCaseId: originalCase }, sources.booking.observation.targetRef, op.signal,
          async stop => { await permit(); return currentPolicy(target, stop); }));
          if (!exact.ok || !exact.value) return refuse("mismatched");
          const selected = caseReader(target, originalCase, op.signal, async () => { await permit(); return true; });
          const read = await op.wait(selected.reader.inspectAttendance(selected.query(), target.attendeeId, op.signal)); await permit();
          if (!read.ok) return refuse("mismatched");
          const c = read.value;
          return { ...target, patientCase: { patientCaseId: c.patientCaseId, maximum: c.maximum, used: c.used,
            usageFingerprint: c.usageFingerprint, includeCancelled: c.includeCancelled, includeDna: c.includeDna,
            associationCount: c.associationCount, eligibleOnSessionDate: c.eligibleOnSessionDate, effect: effectOf(c) } };
        },
        async beforeClaim(target, op) {
          const classRead = 2 * (target.nativeWorkload.metadataRequests + 1 + Math.max(1, Math.ceil(target.nativeWorkload.attendanceRecords / 100)));
          const caseRead = 2 * (1 + Math.max(1, Math.ceil(target.patientCase.associationCount / 100)));
          // Two fresh pre-send target/case observations, cancellation plus its
          // own native and complete-case inspection, financial source/retention
          // reads, and the explicitly provisioned authority bound. Not a hold.
          const remaining = 2 * (classRead + 1 + caseRead) + 1 + 1 + caseRead + 20 + config.maximumAuthorityRequests;
          return await op.wait(checkClinikoHeadroom(config.cliniko.rateBudget, remaining)) === null;
        },
        request(target, approval) {
          const terms = target.policy.caseSessions?.cancellation;
          if (!terms || Object.keys(approval).sort().join(",") !== "approvedCaseTerms,approvedTerms,cancellationReason,caseEffect,caseTermsVersion,classPolicyVersion,entitlementRef,kind,patientCaseId,policyVersion,termsVersion,timeZone" ||
              approval.kind !== "cancelUnpaidCaseClass" || approval.classPolicyVersion !== target.policy.policyVersion || approval.timeZone !== target.policy.timeZone ||
              approval.caseTermsVersion !== terms.version || approval.patientCaseId !== target.patientCase.patientCaseId || !approvalRef(approval.entitlementRef) ||
              approval.caseEffect !== target.patientCase.effect || approval.approvedCaseTerms !== terms[target.patientCase.effect]) return undefined;
          return { target, cancellation: { kind: "cancel", scope: target.scope, patientId: target.patientId, sessionId: target.sessionId,
            attendeeId: target.attendeeId, actionId: target.cancellationActionId, cancellationReason: approval.cancellationReason } };
        },
        async cancelOnce(request, signal, beforeSend, afterSendRead) {
          let cancelled = false;
          try {
            const sent = await writer.value.executeOnce(request.cancellation, signal, beforeSend);
            if (!sent.ok || sent.value.kind !== "accepted" || sent.value.attendeeRef !== `cliniko:attendee:${request.target.attendeeId}`) return ok({ kind: "uncertain" });
            const permit = async (stop: AbortSignal) => await afterSendRead(stop) && await currentPolicy(request.target, stop);
            const exact = await writer.value.inspect(request.cancellation, sent.value.attendeeRef, signal, permit);
            if (!exact.ok || !exact.value) return ok({ kind: "uncertain" }); cancelled = true;
            const selected = caseReader(request.target, request.target.patientCase.patientCaseId, signal, permit);
            const inspected = await selected.reader.inspectCancellation(selected.query(), request.target.patientCase.usageFingerprint,
              request.target.attendeeId, signal, request.cancellation.cancellationReason);
            const c = request.target.patientCase, delta = c.effect === "releaseOne" ? -1 : c.effect === "consumeOne" ? 1 : 0;
            const verified = inspected.ok && inspected.value.maximum === c.maximum && inspected.value.used === c.used + delta;
            return ok({ kind: "cancelled", reviewRequired: !verified });
          } catch { return ok({ kind: cancelled ? "cancelled" : "uncertain", reviewRequired: true }); }
        },
      });
      return protocol.ok ? ok(new ClinikoFinancialCaseClassExpiryOwner(protocol.value)) : protocol;
    } catch { return err({ kind: "invalidConfig" }); }
  }
  expireOnce(binding: FinancialLifecycleBinding, signal: AbortSignal): Promise<Result<FinancialClinicalExpiryOutcome, FinancialClinicalExpiryFailure>> { return this.#protocol.expireOnce(binding, signal); }
}
