import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { PatientProofHost } from "../core/host.ts";
import { ClinikoClassAttendanceReader } from "../cliniko/class-attendance-read.ts";
import { ClinikoClassAttendanceWriter } from "../cliniko/class-attendance-write.ts";
import type { ClinikoAttendanceRequest } from "../cliniko/class-attendance-write.ts";
import type { FinancialRecordAuthority } from "../cliniko/financial-record-retention.ts";
import { OwnerFileClassPolicy } from "./owner-file-class-policy.ts";
import type { ClassApproval } from "./owner-file-class-policy.ts";
import { sameScope } from "./appointment-change-authority.ts";
import type { FinancialEffectBarrier } from "./financial-effect-barrier.ts";
import type { FinancialLifecycleBinding } from "./financial-lifecycle-sources.ts";
import { FinancialClinicalExpiryProtocol, FinancialClinicalExpiryRefusal } from "./financial-clinical-expiry-protocol.ts";
import type { FinancialExpiryQuery, FinancialExpiryAuthority, FinancialExpiryApproval,
  FinancialClinicalExpiryConfig, FinancialClinicalExpiryOutcome, FinancialClinicalExpiryFailure } from "./financial-clinical-expiry-protocol.ts";

type Cancellation = Extract<ClinikoAttendanceRequest, { kind: "cancel" }>;
export type FinancialUnlinkedClassTarget = Readonly<{
  scope: LocationScope; patientId: string; sessionId: string; attendeeId: string; creationActionId: string;
  cancellationActionId: string; startsAt: string; endsAt: string; policy: ClassApproval;
}>;
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
      const currentPolicy = async (target: FinancialUnlinkedClassTarget, signal: AbortSignal) => {
        const current = await config.classPolicy.current(target.scope);
        return !signal.aborted && current.ok && isDeepStrictEqual(current.value, target.policy);
      };
      const protocol = FinancialClinicalExpiryProtocol.create<FinancialUnlinkedClassTarget, FinancialUnlinkedClassApproval, Request>(config, authority, records, barrier, native, stripe, {
        async read(sources, op, permit) {
          const i = sources.intent.intent, origin = sources.booking.observation.classCreationRequest;
          const attendeeId = /^cliniko:attendee:([1-9][0-9]{0,18})$/.exec(sources.booking.observation.targetRef)?.[1];
          if (i.booking.kind !== "classBook" || !attendeeId || !origin || origin.sessionId !== i.booking.sessionId ||
              Object.hasOwn(origin, "patientCaseId")) return refuse();
          const approved = await op.wait(config.classPolicy.current(i.scope)); await permit();
          if (!approved.ok || approved.value.membership !== "independentHost" || approved.value.businessId !== i.businessId ||
              approved.value.credentialFingerprint !== i.credentialFingerprint || approved.value.practitionerId !== i.booking.practitionerId ||
              approved.value.appointmentTypeId !== i.booking.appointmentTypeId) return refuse();
          const target: FinancialUnlinkedClassTarget = { scope: i.scope, patientId: i.patientId, sessionId: i.booking.sessionId,
            attendeeId, creationActionId: i.booking.actionRef, cancellationActionId: i.effects.clinicalExpiry,
            startsAt: i.booking.startsAt, endsAt: i.booking.endsAt, policy: approved.value };
          const began = Date.parse(clock()), reference = `financial-unlinked-class-read:${randomUUID()}`;
          // Private read capability derived from fresh financial-owner read
          // admission. It never represents caller verification or write consent.
          const proof: PatientProofHost = { verifyPatient: async (scope, ref, now, signal) => {
            const at = Date.parse(clock());
            if (op.signal.aborted || signal?.aborted || !sameScope(scope, i.scope) || ref !== reference || !Number.isFinite(at) ||
                at < began || at >= began + 30_000 || Math.abs(Date.parse(now) - at) > 30_000 || !await currentPolicy(target, op.signal))
              return err({ kind: "unavailable", target: "patient" });
            await permit();
            return ok({ scope: { ...i.scope }, patientRef: i.patientId, verificationRef: reference, expiresAt: new Date(began + 180_000).toISOString() });
          } };
          const reader = ClinikoClassAttendanceReader.create({ ...nativeConfig, className: approved.value.className }, proof, native, clock);
          if (!reader.ok) return refuse();
          const read = await op.wait(reader.value.inspect(i.scope, reference, target.sessionId, target.startsAt, target.endsAt, clock(), op.signal));
          await permit();
          if (!read.ok || read.value.timeZone !== approved.value.timeZone || read.value.sessions.length !== 1) return refuse("mismatched");
          const session = read.value.sessions[0]!;
          if (session.sessionRef !== target.sessionId || session.startsAt !== target.startsAt || session.endsAt !== target.endsAt ||
              session.attendance.kind !== "one" || session.attendance.attendeeRef !== target.attendeeId) return refuse("mismatched");
          const unlinked = await op.wait(writer.value.inspectUnlinked({ kind: "book", scope: target.scope, patientId: target.patientId,
            sessionId: target.sessionId, actionId: target.creationActionId }, sources.booking.observation.targetRef, op.signal,
          async () => { await permit(); return currentPolicy(target, op.signal); }));
          await permit();
          if (!unlinked.ok || !unlinked.value || !await currentPolicy(target, op.signal)) return refuse("mismatched");
          return target;
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
