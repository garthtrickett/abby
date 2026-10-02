import { CALL_TERMINAL_REASONS, STAFF_REASONS, err, ok } from "../core/model.ts";
import type { ActionState, CallState, CallTerminal, LocationScope, Result, StaffItem, TransitionFailure } from "../core/model.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { reviewNotifications } from "./notification-review.ts";
import type { NotificationReviewRow } from "./notification-review-shape.ts";

export type CallSummary = Readonly<{
  callId: string;
  lifecycle: CallState["lifecycle"];
  version: number;
  terminal?: CallTerminal;
  notifications?: readonly NotificationReviewRow[];
  actions: readonly Readonly<{ kind: ActionState["kind"]; status: ActionState["status"] }>[];
  staffItems: readonly Readonly<{ reason: StaffItem["reason"]; status: StaffItem["status"] }>[];
  knowledgeAnswers: readonly Readonly<{ sourceRef: string; version: string; ownerRef: string }>[];
  availabilityReads: readonly Readonly<{ status: "shown" | "empty" | "failed"; sourceRef?: string; timeZone?: string; shownCount: number; reason?: string }>[];
  appointmentReads: readonly Readonly<{ status: "shown" | "empty" | "failed"; sourceRef?: string; shownCount: number; reason?: string }>[];
}>;

const actionKinds = ["book", "cancel", "reschedule", "intake"] as const;
const actionStatuses = ["awaitingConfirmation", "ready", "dispatched", "committed", "rejected", "unsupported", "uncertain", "needsReview", "canceled"] as const;
const staffStatuses = ["requested", "open", "acknowledged", "resolved", "needsReview", "failed"] as const;

function allowed(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}

/** Redacted projection shared by exact-call review and scoped reporting. */
export function summarizeCall(call: CallState): Result<CallSummary, TransitionFailure> {
  const actions = Object.values(call.actions);
  const staffItems = Object.values(call.staffItems);
  const notifications = reviewNotifications(call);
  if (!notifications.ok) return notifications;
  if (actions.some(item => !item || !allowed(actionKinds, item.kind) || !allowed(actionStatuses, item.status)) ||
      (call.terminal !== undefined && (!call.terminal || call.lifecycle !== "ended" || !CALL_TERMINAL_REASONS.includes(call.terminal.reason) ||
        typeof call.terminal.at !== "string" || !Number.isFinite(Date.parse(call.terminal.at)))) ||
      staffItems.some(item => !item || !allowed(STAFF_REASONS, item.reason) || !allowed(staffStatuses, item.status)) ||
      !Array.isArray(call.knowledgeAnswers) || call.knowledgeAnswers.some(item => !item ||
        typeof item.sourceRef !== "string" || !item.sourceRef || typeof item.version !== "string" || !item.version ||
        typeof item.ownerRef !== "string" || !item.ownerRef) ||
      !Array.isArray(call.availabilityReads) || call.availabilityReads.some(item => !item ||
        !allowed(["shown", "empty", "failed"], item.status) ||
        (item.sourceRef !== undefined && typeof item.sourceRef !== "string") ||
        (item.timeZone !== undefined && typeof item.timeZone !== "string") ||
        (item.reason !== undefined && typeof item.reason !== "string") ||
        (item.shownStartsAt !== undefined && !Array.isArray(item.shownStartsAt))) ||
      !Array.isArray(call.appointmentReads) || call.appointmentReads.some(item => !item ||
        !allowed(["shown", "empty", "failed"], item.status) ||
        (item.sourceRef !== undefined && typeof item.sourceRef !== "string") ||
        (item.reason !== undefined && typeof item.reason !== "string") ||
        (item.shownCount !== undefined && (!Number.isSafeInteger(item.shownCount) || item.shownCount < 0)))) {
    return err({ kind: "storageCorrupt" });
  }
  return ok({
    callId: call.callId,
    lifecycle: call.lifecycle,
    version: call.version,
    ...(notifications.value.length ? { notifications: notifications.value } : {}),
    ...(call.terminal === undefined ? {} : { terminal: { reason: call.terminal.reason, at: call.terminal.at } }),
    actions: actions.map(({ kind, status }) => ({ kind, status })),
    staffItems: staffItems.map(({ reason, status }) => ({ reason, status })),
    knowledgeAnswers: call.knowledgeAnswers.map(({ sourceRef, version, ownerRef }) => ({ sourceRef, version, ownerRef })),
    availabilityReads: call.availabilityReads.map(({ status, sourceRef, timeZone, shownStartsAt, reason }) => ({ status,
      shownCount: shownStartsAt?.length ?? 0,
      ...(sourceRef === undefined ? {} : { sourceRef }),
      ...(timeZone === undefined ? {} : { timeZone }),
      ...(reason === undefined ? {} : { reason }) })),
    appointmentReads: call.appointmentReads.map(({ status, sourceRef, shownCount, reason }) => ({ status,
      shownCount: shownCount ?? 0,
      ...(sourceRef === undefined ? {} : { sourceRef }),
      ...(reason === undefined ? {} : { reason }) })),
  });
}

/** Scoped, redacted projection for staff and agents; no patient refs or spoken text leave this boundary. */
export class CallReview {
  private readonly ledger: LedgerStore;

  constructor(ledger: LedgerStore) { this.ledger = ledger; }

  async read(callId: string, scope: LocationScope): Promise<Result<CallSummary, TransitionFailure>> {
    const result = await this.ledger.read(callId, scope);
    return result.ok ? summarizeCall(result.value) : result;
  }
}
