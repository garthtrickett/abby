import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { ClinikoCancellationWriter } from "../cliniko/appointment-write.ts";
import type { ClinikoAppointmentTarget, ClinikoCancellationRequest } from "../cliniko/appointment-write.ts";
import type { FinancialRecordAuthority } from "../cliniko/financial-record-retention.ts";
import type { FinancialEffectBarrier } from "./financial-effect-barrier.ts";
import type { FinancialLifecycleBinding } from "./financial-lifecycle-sources.ts";
import { FinancialClinicalExpiryProtocol, FinancialClinicalExpiryRefusal } from "./financial-clinical-expiry-protocol.ts";
import type { FinancialExpiryQuery, FinancialExpiryAuthority, FinancialExpiryApproval,
  FinancialClinicalExpiryConfig, FinancialClinicalExpiryOutcome, FinancialClinicalExpiryFailure } from "./financial-clinical-expiry-protocol.ts";
export type { FinancialClinicalReferenceQuery, FinancialClinicalExpiryConfig, FinancialClinicalExpiryOutcome,
  FinancialClinicalExpiryFailure } from "./financial-clinical-expiry-protocol.ts";
export type FinancialClinicalExpiryQuery = FinancialExpiryQuery<ClinikoAppointmentTarget>;
export type FinancialClinicalApproval = FinancialExpiryApproval & Readonly<{ kind: "cancelUnpaidIndividual"; cancellationReason: ClinikoCancellationRequest["cancellationReason"] }>;
export type FinancialClinicalExpiryAuthority = FinancialExpiryAuthority<ClinikoAppointmentTarget, FinancialClinicalApproval>;

/** Concrete individual native contract: current active target, explicitly
 * approved cancellation reason, then PATCH204 and exact cancelled inspection.
 * Class/case/pass writes cannot use this adapter. */
export class ClinikoFinancialClinicalExpiryOwner {
  readonly #protocol: FinancialClinicalExpiryProtocol<ClinikoAppointmentTarget, FinancialClinicalApproval, ClinikoCancellationRequest>;
  private constructor(protocol: FinancialClinicalExpiryProtocol<ClinikoAppointmentTarget, FinancialClinicalApproval, ClinikoCancellationRequest>) { this.#protocol = protocol; }
  static create(config: FinancialClinicalExpiryConfig, authority: FinancialClinicalExpiryAuthority, records: FinancialRecordAuthority,
    barrier: FinancialEffectBarrier, native: typeof fetch = fetch, stripe: typeof fetch = fetch): Result<ClinikoFinancialClinicalExpiryOwner, FinancialClinicalExpiryFailure> {
    try {
      const writer = ClinikoCancellationWriter.create(config.cliniko, native, config.cliniko.clock);
      if (!writer.ok) return err({ kind: "invalidConfig" });
      const protocol = FinancialClinicalExpiryProtocol.create<ClinikoAppointmentTarget, FinancialClinicalApproval, ClinikoCancellationRequest>(config, authority, records, barrier, native, stripe, {
        async read(sources, op, permit) {
          const i = sources.intent.intent;
          const appointmentId = /^cliniko:appointment:([1-9][0-9]{0,18})$/.exec(sources.booking.observation.targetRef)?.[1];
          if (i.booking.kind !== "book" || !appointmentId) throw new FinancialClinicalExpiryRefusal("forbidden");
          const target = { scope: i.scope, patientId: i.patientId, appointmentId, practitionerId: i.booking.practitionerId,
            appointmentTypeId: i.booking.appointmentTypeId, startsAt: i.booking.startsAt, endsAt: i.booking.endsAt };
          const observed = await op.wait(writer.value.observe(target, op.signal)); await permit();
          if (!observed.ok || observed.value.kind !== "active") throw new FinancialClinicalExpiryRefusal("mismatched");
          return target;
        },
        request(target, approval) {
          if (Object.keys(approval).sort().join(",") !== "approvedTerms,cancellationReason,kind,policyVersion,termsVersion,timeZone" ||
              approval.kind !== "cancelUnpaidIndividual") return undefined;
          return { ...target, cancellationReason: approval.cancellationReason };
        },
        cancelOnce: (request, signal, permit) => writer.value.cancelOnce(request, signal, permit),
      });
      return protocol.ok ? ok(new ClinikoFinancialClinicalExpiryOwner(protocol.value)) : protocol;
    } catch { return err({ kind: "invalidConfig" }); }
  }
  expireOnce(binding: FinancialLifecycleBinding, signal: AbortSignal): Promise<Result<FinancialClinicalExpiryOutcome, FinancialClinicalExpiryFailure>> {
    return this.#protocol.expireOnce(binding, signal);
  }
}
