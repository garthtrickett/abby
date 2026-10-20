import { validVoicePresentation } from "../core/voice-presentation.ts";
import { validVoicePolicy } from "../core/voice-profile.ts";
import type { ModelKnowledgeContextHost } from "../core/host.ts";
import { captureKnowledgeSnapshot, validKnowledgeSnapshot } from "../core/knowledge-evidence.ts";
import { err, ok } from "../core/model.ts";
import type { CallPolicy, Result, TransitionFailure } from "../core/model.ts";
import { validApprovedGreeting, validGreetingAt } from "../core/greeting.ts";
import { expandStaffSchedule, validApprovedStaffSchedule, validStaffScheduleApproval } from "../core/staff-schedule.ts";
import type { AutomationReadiness } from "../core/readiness.ts";
import type { RouteFailure } from "./admission.ts";

/** Shared policy capture for incoming routing and an independently selected outgoing scope. */
export async function prepareVoiceAdmissionPolicy(policy: CallPolicy, readiness: AutomationReadiness,
  now: () => string, knowledge?: ModelKnowledgeContextHost):
  Promise<Result<Readonly<{ policy: CallPolicy; acceptedAt: string }>, RouteFailure | TransitionFailure>> {
  if (policy.automationEnabled !== true) return err({ kind: "automationDisabled" });
  if (!validVoicePolicy(policy, policy.scope) || !policy.voiceProfile || !validVoicePresentation(policy.voiceProfile)) return err({ kind: "readinessFailed" });
  policy = structuredClone(policy);
  if (!validApprovedGreeting(policy)) return err({ kind: "readinessFailed" });
  let ready = false;
  try {
    const checked = await readiness(policy.scope);
    ready = checked.ok && checked.value === true;
  } catch { ready = false; }
  if (!ready) return err({ kind: "readinessFailed" });
  const acceptedAt = now();
  if (!Number.isFinite(Date.parse(acceptedAt))) return err({ kind: "invalidTransition" });
  if (!validGreetingAt(policy.greeting, policy.scope, acceptedAt)) return err({ kind: "readinessFailed" });
  let callPolicy = policy;
  if (policy.staffSchedule !== undefined) {
    const { staffSchedule, staffedCoverage: staleCoverage, staffedIntervals: staleIntervals, ...base } = policy;
    void staleCoverage; void staleIntervals;
    callPolicy = base;
    try {
      if (validApprovedStaffSchedule(staffSchedule, policy.scope) &&
          validStaffScheduleApproval(staffSchedule, policy.scope, acceptedAt)) {
        const through = new Date(Math.min(Date.parse(acceptedAt) + 72 * 60 * 60 * 1_000,
          Date.parse(staffSchedule.effectiveUntil))).toISOString();
        const expanded = expandStaffSchedule(staffSchedule, acceptedAt, through);
        if (expanded.ok) callPolicy = { ...base, staffSchedule: structuredClone(staffSchedule), ...expanded.value };
      }
    } catch { /* Invalid host hours leave transfer and closed-hours claims unavailable. */ }
  }
  if (knowledge) {
    const captured = await captureKnowledgeSnapshot(knowledge, callPolicy.scope, acceptedAt);
    if (!captured.ok) return err({ kind: "routeUnavailable" });
    callPolicy = { ...callPolicy, knowledgeSnapshot: captured.value };
  }
  if (callPolicy.knowledgeSnapshot !== undefined && !validKnowledgeSnapshot(callPolicy.knowledgeSnapshot)) {
    return err({ kind: "routeUnavailable" });
  }
  return ok({ policy: callPolicy, acceptedAt });
}
