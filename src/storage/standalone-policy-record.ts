import type { CallPolicy, LocationScope } from "../core/model.ts";

/** Exact standalone policy storage contract; no native capability or patient fields. */
export function storedStandalonePolicy(scope: LocationScope, version: number, policy: CallPolicy):
  Readonly<{ scope: LocationScope; policyVersion: string; bookingEnabled: boolean; cancellationEnabled: boolean; reschedulingEnabled: boolean;
    afterHoursMode: NonNullable<CallPolicy["afterHoursMode"]>; afterHoursInfo?: NonNullable<CallPolicy["afterHoursInfo"]>;
    urgentResponse?: NonNullable<CallPolicy["urgentResponse"]>;
    staffSchedule?: NonNullable<CallPolicy["staffSchedule"]>;
    transferDestinationRef?: string;
    greeting: NonNullable<CallPolicy["greeting"]> | null }> {
  return { scope: { ...scope }, policyVersion: String(version), bookingEnabled: policy.bookingEnabled,
    cancellationEnabled: policy.cancellationEnabled ?? false, reschedulingEnabled: policy.reschedulingEnabled ?? false,
    afterHoursMode: policy.afterHoursMode ?? "staffRequest",
    ...(policy.afterHoursInfo ? { afterHoursInfo: policy.afterHoursInfo } : {}),
    ...(policy.urgentResponse ? { urgentResponse: policy.urgentResponse } : {}),
    ...(policy.staffSchedule ? { staffSchedule: policy.staffSchedule } : {}),
    ...(policy.transferDestinationRef === undefined ? {} : { transferDestinationRef: policy.transferDestinationRef }),
    greeting: policy.greeting ?? null };
}

