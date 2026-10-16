import type { ActionState, CallState, Presentation, StaffItem } from "../core/model.ts";
import { classMovementSummary } from "../core/class-movement-continuation.ts";
import type { ClassMovementSummary } from "../core/class-movement-continuation.ts";

/** Agent-visible receipt for a turn command. It carries keys and outcomes, never host evidence or spoken content. */
export type CallCommandProgress = Readonly<{
  callId: string;
  traceKey: string;
  callVersion: number;
  lifecycle: CallState["lifecycle"];
  actions: readonly Readonly<{ actionKey: string; kind: ActionState["kind"]; status: ActionState["status"]; presentationId: string; classMovement?: ClassMovementSummary }>[];
  staffItems: readonly Readonly<{ taskKey: string; reason: StaffItem["reason"]; status: StaffItem["status"] }>[];
  pendingPresentation?: Readonly<{ presentationId: string; kind: Presentation["kind"]; status: Presentation["status"] }>;
  knowledgeSources: readonly Readonly<{ sourceRef: string; version: string; ownerRef: string }>[];
  availability?: Readonly<{ status: "shown" | "empty" | "failed"; sourceRef?: string; timeZone?: string; shownCount: number; reason?: string }>;
  appointments?: Readonly<{ status: "shown" | "empty" | "failed"; sourceRef?: string; shownCount: number; reason?: string }>;
}>;

export function commandProgress(state: CallState, traceKey: string): CallCommandProgress {
  const pending = state.pendingPresentationId ? state.presentations[state.pendingPresentationId] : undefined;
  const availability = state.availabilityReads.filter(item => item.turnId === traceKey).at(-1);
  const appointments = state.appointmentReads.filter(item => item.turnId === traceKey).at(-1);
  return {
    callId: state.callId, traceKey, callVersion: state.version, lifecycle: state.lifecycle,
    actions: (state.callerIdentityDenied ? [] : Object.values(state.actions)).map(action => {
      const movement = classMovementSummary(action.classMovement);
      return { actionKey: action.key, kind: action.kind, status: action.status, presentationId: action.presentationId,
        ...(movement ? { classMovement: movement } : {}) };
    }),
    staffItems: (state.callerIdentityDenied ? [] : Object.values(state.staffItems)).map(item => ({ taskKey: item.key, reason: item.reason, status: item.status })),
    ...(pending ? { pendingPresentation: { presentationId: pending.id, kind: pending.kind, status: pending.status } } : {}),
    knowledgeSources: state.knowledgeAnswers.filter(item => item.turnId === traceKey)
      .map(({ sourceRef, version, ownerRef }) => ({ sourceRef, version, ownerRef })),
    ...(availability ? { availability: { status: availability.status, shownCount: availability.shownStartsAt?.length ?? 0,
      ...(availability.sourceRef === undefined ? {} : { sourceRef: availability.sourceRef }),
      ...(availability.timeZone === undefined ? {} : { timeZone: availability.timeZone }),
      ...(availability.reason === undefined ? {} : { reason: availability.reason }) } } : {}),
    ...(!state.callerIdentityDenied && appointments ? { appointments: { status: appointments.status, shownCount: appointments.shownCount ?? 0,
      ...(appointments.sourceRef === undefined ? {} : { sourceRef: appointments.sourceRef }),
      ...(appointments.reason === undefined ? {} : { reason: appointments.reason }) } } : {}),
  };
}
