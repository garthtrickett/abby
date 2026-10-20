import { isDeepStrictEqual } from "node:util";
import type { LocationScope } from "../core/model.ts";
import { ClinikoClassAttendanceReader } from "../cliniko/class-attendance-read.ts";
import type { ClinikoAttendanceConfig } from "../cliniko/class-attendance-write.ts";
import type { ClassApproval } from "./owner-file-class-policy.ts";
import type { OwnerFileClassPolicy } from "./owner-file-class-policy.ts";
import type { FinancialLifecycleSources, FinancialLifecycleOperation } from "./financial-lifecycle-sources.ts";
import { FinancialClinicalExpiryRefusal } from "./financial-clinical-expiry-protocol.ts";
import { financialClinicalNativeRead } from "./financial-clinical-native-read.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

export type FinancialClinicalClassTarget = Readonly<{
  scope: LocationScope; patientId: string; sessionId: string; attendeeId: string; creationActionId: string;
  cancellationActionId: string; startsAt: string; endsAt: string; policy: ClassApproval;
  nativeWorkload: Readonly<{ metadataRequests: number; attendanceRecords: number }>;
}>;
type Config = Readonly<{ cliniko: ClinikoAttendanceConfig; classPolicy: OwnerFileClassPolicy; clock(): string; native: typeof fetch }>;
const refuse = (kind: "forbidden" | "mismatched" = "forbidden"): never => { throw new FinancialClinicalExpiryRefusal(kind); };
export async function currentFinancialClassPolicy(policy: OwnerFileClassPolicy, target: FinancialClinicalClassTarget, signal: AbortSignal): Promise<boolean> {
  const current = await awaitUntilAbort(policy.current(target.scope), signal);
  return !signal.aborted && current?.ok === true && isDeepStrictEqual(current.value, target.policy);
}

/** Exact class identity/own attendance only. Concrete adapters must separately
 * prove the current case/absence and cancellation/counter contract. */
export async function readFinancialClinicalClassTarget(config: Config, sources: FinancialLifecycleSources,
  op: FinancialLifecycleOperation, permit: () => Promise<void>, membership: ClassApproval["membership"]): Promise<FinancialClinicalClassTarget> {
  const i = sources.intent.intent, origin = sources.booking.observation.classCreationRequest;
  const attendeeId = /^cliniko:attendee:([1-9][0-9]{0,18})$/.exec(sources.booking.observation.targetRef)?.[1];
  if (i.booking.kind !== "classBook" || !attendeeId || !origin || origin.sessionId !== i.booking.sessionId) return refuse();
  const approved = await op.wait(config.classPolicy.current(i.scope)); await permit();
  if (!approved.ok || approved.value.membership !== membership || approved.value.businessId !== i.businessId ||
      approved.value.credentialFingerprint !== i.credentialFingerprint || approved.value.practitionerId !== i.booking.practitionerId ||
      approved.value.appointmentTypeId !== i.booking.appointmentTypeId) return refuse();
  const identity = { scope: i.scope, patientId: i.patientId, sessionId: i.booking.sessionId, attendeeId,
    creationActionId: i.booking.actionRef, cancellationActionId: i.effects.clinicalExpiry,
    startsAt: i.booking.startsAt, endsAt: i.booking.endsAt, policy: approved.value };
  const capability = financialClinicalNativeRead({ scope: i.scope, patientId: i.patientId, signal: op.signal, clock: config.clock,
    current: async signal => {
      await permit();
      const current = await awaitUntilAbort(config.classPolicy.current(i.scope), signal);
      return current?.ok === true && !signal.aborted && isDeepStrictEqual(current.value, approved.value);
    } });
  const reader = ClinikoClassAttendanceReader.create({ ...config.cliniko, className: approved.value.className }, capability.proof, config.native, config.clock);
  if (!reader.ok) return refuse();
  const read = await op.wait(reader.value.inspect(i.scope, capability.reference, identity.sessionId, identity.startsAt, identity.endsAt, config.clock(), op.signal));
  await permit();
  if (!read.ok || read.value.timeZone !== approved.value.timeZone || read.value.sessions.length !== 1) return refuse("mismatched");
  const session = read.value.sessions[0]!;
  if (session.sessionRef !== identity.sessionId || session.startsAt !== identity.startsAt || session.endsAt !== identity.endsAt ||
      session.attendance.kind !== "one" || session.attendance.attendeeRef !== identity.attendeeId || !session.nativeWorkload) return refuse("mismatched");
  return { ...identity, nativeWorkload: session.nativeWorkload };
}
