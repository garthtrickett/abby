import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { CallTerminalReason, LocationScope, Result, TransitionFailure } from "../core/model.ts";
import { summarizeCall } from "./call-review.ts";
import { notificationDeliveryCounts, sumNotificationDeliveryCounts } from "./notification-delivery-counts.ts";
import type { NotificationDeliveryCounts } from "./notification-delivery-counts.ts";

export type CallOutcomeRow = Readonly<{
  callId: string;
  lifecycle: "starting" | "active" | "ended";
  terminalReason?: CallTerminalReason;
  committedActions: number;
  unresolvedActions: number;
  staffRequests: number;
  hostConfirmedTasks: number;
  staffNeedsReview: number;
  systemFailure: boolean;
  notificationDelivery?: NotificationDeliveryCounts;
}>;

export type CallOutcomePage = Readonly<{
  rows: readonly CallOutcomeRow[];
  totals: Readonly<{
    calls: number;
    committedActions: number;
    callsWithUnresolvedActions: number;
    callsWithStaffRequests: number;
    callsWithHostConfirmedTasks: number;
    callsWithStaffNeedsReview: number;
    callsWithSystemFailure: number;
    callsWithCallerDisconnect: number;
    callsWithMediaFailure: number;
    callsWithLeaseExpiry: number;
    callsWithTransferConnected: number;
  }>;
  nextAfterCallId?: string;
  notificationDelivery?: NotificationDeliveryCounts;
}>;

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

/** Each page is bounded and redacted. Totals describe this page, not a cross-page snapshot. */
export class CallOutcomeReport {
  private readonly ledger: LedgerStore;

  constructor(ledger: LedgerStore) { this.ledger = ledger; }

  async list(scope: LocationScope, afterCallId?: string): Promise<Result<CallOutcomePage, TransitionFailure>> {
    if (afterCallId !== undefined && (!afterCallId || afterCallId.length > 256)) return err({ kind: "invalidTransition" });
    const found = await this.ledger.listCalls(scope, afterCallId);
    if (!found.ok) return found;
    if (found.value.length > 100) return err({ kind: "storageCorrupt" });
    const rows: CallOutcomeRow[] = [];
    for (const call of found.value) {
      if (!call || typeof call.callId !== "string" || !call.callId || call.callId.length > 256 ||
          !["starting", "active", "ended"].includes(call.lifecycle) || !Number.isSafeInteger(call.version) || call.version < 0 ||
          (afterCallId !== undefined && call.callId <= afterCallId) ||
          (rows.length > 0 && call.callId <= rows[rows.length - 1]!.callId) ||
          !call.policy?.scope || !sameScope(call.policy.scope, scope)) return err({ kind: "storageCorrupt" });
      const summary = summarizeCall(call);
      if (!summary.ok) return summary;
      const actions = summary.value.actions;
      const items = summary.value.staffItems;
      const notifications = notificationDeliveryCounts(summary.value.notifications);
      rows.push({ callId: summary.value.callId, lifecycle: summary.value.lifecycle,
        ...(summary.value.terminal ? { terminalReason: summary.value.terminal.reason } : {}),
        committedActions: actions.filter(item => item.status === "committed").length,
        unresolvedActions: actions.filter(item => item.status === "uncertain" || item.status === "needsReview" || item.classMovement?.outcome === "pending").length,
        staffRequests: items.length,
        hostConfirmedTasks: items.filter(item => item.status === "open" || item.status === "acknowledged" || item.status === "resolved").length,
        staffNeedsReview: items.filter(item => item.status === "needsReview" || item.status === "failed").length,
        systemFailure: items.some(item => item.reason === "systemFailure"),
        ...(notifications ? { notificationDelivery: notifications } : {}) });
    }
    const notificationDelivery = sumNotificationDeliveryCounts(rows.map(row => row.notificationDelivery));
    return ok({ rows, ...(notificationDelivery ? { notificationDelivery } : {}), totals: {
      calls: rows.length,
      committedActions: rows.reduce((sum, row) => sum + row.committedActions, 0),
      callsWithUnresolvedActions: rows.filter(row => row.unresolvedActions > 0).length,
      callsWithStaffRequests: rows.filter(row => row.staffRequests > 0).length,
      callsWithHostConfirmedTasks: rows.filter(row => row.hostConfirmedTasks > 0).length,
      callsWithStaffNeedsReview: rows.filter(row => row.staffNeedsReview > 0).length,
      callsWithSystemFailure: rows.filter(row => row.systemFailure).length,
      callsWithCallerDisconnect: rows.filter(row => row.terminalReason === "callerDisconnected").length,
      callsWithMediaFailure: rows.filter(row => row.terminalReason === "mediaFailure").length,
      callsWithLeaseExpiry: rows.filter(row => row.terminalReason === "leaseExpired" || row.terminalReason === "localLeaseClosed").length,
      callsWithTransferConnected: rows.filter(row => row.terminalReason === "transferConnected").length,
    }, ...(rows.length === 100 ? { nextAfterCallId: rows[99]!.callId } : {}) });
  }
}
