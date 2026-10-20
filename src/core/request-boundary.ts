import type { CallState } from "./model.ts";
import { actionOutcomeText } from "./action-outcome.ts";

export const REQUEST_BOUNDARIES = ["minorIntake", "proxyPatient", "jointPractitioners", "groupClass", "externalAppointmentChange"] as const;
export type RequestBoundary = typeof REQUEST_BOUNDARIES[number];
export function validRequestBoundary(value: unknown): value is RequestBoundary {
  return typeof value === "string" && (REQUEST_BOUNDARIES as readonly string[]).includes(value);
}
const notices: Record<RequestBoundary, string> = {
  externalAppointmentChange: "I can't confirm a change made elsewhere or on an earlier call from that statement. A fresh verified appointment check is needed. Please ask to check your current appointments, or contact the clinic directly.",
  minorIntake: "I can't register a child or act for a child in this call. Please contact the clinic directly.",
  proxyPatient: "I can only handle an individual appointment for the verified caller. I can't change another person's appointment or combine different people's changes on this call. Please contact the clinic directly.",
  jointPractitioners: "I can't arrange a visit requiring several practitioners together from this call. Please contact the clinic directly.",
  groupClass: "This call handles individual appointments. I can't manage group-class attendance here. Please contact the clinic directly about the class.",
};

export function hasSentPatientWork(state: CallState): boolean {
  return Object.values(state.effects).some(effect => (effect.kind === "hostWrite" || effect.kind === "staffTask") &&
    ["possiblySent", "completed", "uncertain"].includes(effect.status));
}
export function requestBoundaryText(state: CallState, reason: RequestBoundary): string {
  const sent = Object.values(state.actions).filter(action => action.classMovement || ["dispatched", "committed", "uncertain", "needsReview"].includes(action.status)).at(-1);
  return sent ? `${actionOutcomeText(sent)} ${notices[reason]}` : notices[reason];
}
