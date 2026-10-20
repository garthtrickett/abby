import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { ClinikoClassAttendanceWriter } from "../cliniko/class-attendance-write.ts";
import type { ClinikoAttendanceRequest } from "../cliniko/class-attendance-write.ts";
import type { FinancialRecordAuthority } from "../cliniko/financial-record-retention.ts";
import { checkClinikoHeadroom } from "../cliniko/read-budget.ts";
import { OwnerFileClassPolicy } from "./owner-file-class-policy.ts";
import { sameScope } from "./appointment-change-authority.ts";
import type { FinancialEffectBarrier } from "./financial-effect-barrier.ts";
import type { FinancialLifecycleBinding } from "./financial-lifecycle-sources.ts";
import { FinancialClinicalExpiryProtocol, FinancialClinicalExpiryRefusal } from "./financial-clinical-expiry-protocol.ts";
import type { FinancialExpiryQuery, FinancialExpiryAuthority, FinancialExpiryApproval,
  FinancialClinicalExpiryConfig, FinancialClinicalExpiryOutcome, FinancialClinicalExpiryFailure } from "./financial-clinical-expiry-protocol.ts";

import { readFinancialClinicalClassTarget, currentFinancialClassPolicy } from "./financial-clinical-class-target.ts";
import type { FinancialClinicalClassTarget } from "./financial-clinical-class-target.ts";
type Cancellation = Extract<ClinikoAttendanceRequest, { kind: "cancel" }>;
export type FinancialUnlinkedClassTarget = FinancialClinicalClassTarget;
export type FinancialUnlinkedClassApproval = FinancialExpiryApproval & Readonly<{
  kind: "cancelUnpaidUnlinkedClass"; classPolicyVersion: string; cancellationReason: Cancellation["cancellationReason"];
}>;
export type FinancialUnlinkedClassExpiryQuery = FinancialExpiryQuery<FinancialUnlinkedClassTarget>;
export type FinancialUnlinkedClassExpiryAuthority = FinancialExpiryAuthority<FinancialUnlinkedClassTarget, FinancialUnlinkedClassApproval>;
export type FinancialUnlinkedClassExpiryConfig = FinancialClinicalExpiryConfig & Readonly<{ classPolicy: OwnerFileClassPolicy }>;
type Request = Readonly<{ cancellation: Cancellation; target: FinancialUnlinkedClassTarget }>;
const refuse = (kind: "forbidden" | "mismatched" = "forbidden"): never => { throw new FinancialClinicalExpiryRefusal(kind); };

/** An independently approved cancellation of one future, presently unlinked
 * attendee. No ended caller proof, absent JSON field, pass policy or ordinary
 * appointment writer can authorize this operation. */
export class ClinikoFinancialUnlinkedClassExpiryOwner {
  readonly #protocol: FinancialClinicalExpiryProtocol<FinancialUnlinkedClassTarget, FinancialUnlinkedClassApproval, Request>;
  private constructor(protocol: FinancialClinicalExpiryProtocol<FinancialUnlinkedClassTarget, FinancialUnlinkedClassApproval, Request>) { this.#protocol = protocol; }
  static create(config: FinancialUnlinkedClassExpiryConfig, authority: FinancialUnlinkedClassExpiryAuthority, records: FinancialRecordAuthority,
    barrier: FinancialEffectBarrier, native: typeof fetch = fetch, stripe: typeof fetch = fetch): Result<ClinikoFinancialUnlinkedClassExpiryOwner, FinancialClinicalExpiryFailure> {
    try {
      if (!(config.classPolicy instanceof OwnerFileClassPolicy)) return err({ kind: "invalidConfig" });
      config = Object.freeze({ ...config, cliniko: Object.freeze({ ...config.cliniko }), stripe: Object.freeze({ ...config.stripe }) });
      const binding = config.classPolicy.binding();
      if (!sameScope(binding.scope, config.cliniko.scope) || binding.businessId !== config.cliniko.businessId) return err({ kind: "invalidConfig" });
      const nativeConfig = { ...config.cliniko, practitionerId: binding.practitionerId, appointmentTypeId: binding.appointmentTypeId };
      const clock = config.cliniko.clock ?? (() => new Date().toISOString());
      const writer = ClinikoClassAttendanceWriter.create(nativeConfig, native);
      if (!writer.ok) return err({ kind: "invalidConfig" });
      const currentPolicy = (target: FinancialUnlinkedClassTarget, signal: AbortSignal) => currentFinancialClassPolicy(config.classPolicy, target, signal);
      const protocol = FinancialClinicalExpiryProtocol.create<FinancialUnlinkedClassTarget, FinancialUnlinkedClassApproval, Request>(config, authority, records, barrier, native, stripe, {
        async read(sources, op, permit) {
          const origin = sources.booking.observation.classCreationRequest;
          if (!origin || Object.hasOwn(origin, "patientCaseId")) return refuse();
          const target = await readFinancialClinicalClassTarget({ cliniko: nativeConfig, classPolicy: config.classPolicy, clock, native },
            sources, op, permit, "independentHost");
          const unlinked = await op.wait(writer.value.inspectUnlinked({ kind: "book", scope: target.scope, patientId: target.patientId,
            sessionId: target.sessionId, actionId: target.creationActionId }, sources.booking.observation.targetRef, op.signal,
          async () => { await permit(); return currentPolicy(target, op.signal); }));
          await permit();
          if (!unlinked.ok || !unlinked.value || !await currentPolicy(target, op.signal)) return refuse("mismatched");
          return target;
        },
        async beforeClaim(target, op) {
          const classRead = 2 * (target.nativeWorkload.metadataRequests + 1 + Math.max(1, Math.ceil(target.nativeWorkload.attendanceRecords / 100)));
          // Two renewed class observations (each includes exact unlinked
          // attendance), cancellation and its inspection, plus the shared
          // financial source/possible-attempt reads. Own I/O only, never a hold.
          const remaining = 2 * (classRead + 1) + 2 + 20;
          return op.wait(checkClinikoHeadroom(config.cliniko.rateBudget, remaining));
        },
        request(target, approval) {
          if (Object.keys(approval).sort().join(",") !== "approvedTerms,cancellationReason,classPolicyVersion,kind,policyVersion,termsVersion,timeZone" ||
              approval.kind !== "cancelUnpaidUnlinkedClass" || approval.classPolicyVersion !== target.policy.policyVersion ||
              approval.timeZone !== target.policy.timeZone) return undefined;
          return { target, cancellation: { kind: "cancel", scope: target.scope, patientId: target.patientId, sessionId: target.sessionId,
            attendeeId: target.attendeeId, actionId: target.cancellationActionId, cancellationReason: approval.cancellationReason } };
        },
        async cancelOnce(request, signal, beforeSend, afterSendRead) {
          const sent = await writer.value.executeOnce(request.cancellation, signal, beforeSend);
          if (!sent.ok || sent.value.kind !== "accepted" || sent.value.attendeeRef !== `cliniko:attendee:${request.target.attendeeId}`) return ok({ kind: "uncertain" });
          const inspected = await writer.value.inspectUnlinked(request.cancellation, sent.value.attendeeRef, signal,
            async stop => await afterSendRead(stop) && await currentPolicy(request.target, stop), request.target.creationActionId);
          return ok({ kind: inspected.ok && inspected.value ? "cancelled" : "uncertain" });
        },
      });
      return protocol.ok ? ok(new ClinikoFinancialUnlinkedClassExpiryOwner(protocol.value)) : protocol;
    } catch { return err({ kind: "invalidConfig" }); }
  }
  expireOnce(binding: FinancialLifecycleBinding, signal: AbortSignal): Promise<Result<FinancialClinicalExpiryOutcome, FinancialClinicalExpiryFailure>> {
    return this.#protocol.expireOnce(binding, signal);
  }
}
