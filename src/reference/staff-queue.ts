import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result, StaffItem, StaffQueueEntry, TransitionFailure } from "../core/model.ts";

export type StaffQueuePage = Readonly<{
  items: readonly Readonly<StaffQueueEntry & { overdue: boolean }>[];
  nextAfterTaskKey?: string;
}>;

export type StaffQueueHealth = Readonly<{
  observedAt: string;
  consistency: "nonAtomicScan";
  scanned: number;
  statuses: Readonly<Record<StaffItem["status"], number>>;
  overdue: number;
  reviewRequired: number;
  pendingChange: number;
  alertPending: number;
  alertUncertain: number;
  alertFailed: number;
}>;

const reasons = ["callerRequested", "verificationFailed", "unsupported", "uncertainAction", "partialIntake", "systemFailure", "transferFailed"];
const statuses = ["requested", "open", "acknowledged", "resolved", "needsReview", "failed"];

function valid(entry: StaffQueueEntry): boolean {
  return typeof entry.callId === "string" && !!entry.callId && Number.isSafeInteger(entry.callVersion) && entry.callVersion >= 0 &&
    typeof entry.taskKey === "string" && !!entry.taskKey &&
    reasons.includes(entry.reason) && statuses.includes(entry.status) &&
    typeof entry.dueAt === "string" && Number.isFinite(Date.parse(entry.dueAt)) &&
    !!entry.destination && (entry.destination.kind === "owner" ?
      typeof entry.destination.ownerRef === "string" && !!entry.destination.ownerRef :
      entry.destination.kind === "queue" && typeof entry.destination.queueRef === "string" && !!entry.destination.queueRef) &&
    (entry.linkedActionKey === undefined || typeof entry.linkedActionKey === "string") &&
    (entry.pendingChangeKey === undefined || typeof entry.pendingChangeKey === "string") &&
    (entry.reviewRequired === undefined || typeof entry.reviewRequired === "boolean") &&
    (entry.alerts === undefined || (typeof entry.alerts === "object" && entry.alerts !== null &&
      Object.keys(entry.alerts).every(key => key === "overdue" || key === "needsReview") &&
      Object.values(entry.alerts).every(status => ["pending", "delivered", "uncertain", "failed", "canceled"].includes(status)))) &&
    entry.taskKey.length <= 256 && entry.callId.length <= 256;
}

/** Scoped queue projection. Patient and appointment details never leave the call ledger. */
export class StaffQueue {
  private readonly ledger: LedgerStore;
  private readonly clock: () => string;

  constructor(ledger: LedgerStore, clock: () => string = () => new Date().toISOString()) {
    this.ledger = ledger;
    this.clock = clock;
  }

  async list(scope: LocationScope, afterTaskKey?: string): Promise<Result<StaffQueuePage, TransitionFailure>> {
    if (afterTaskKey !== undefined && (!afterTaskKey || afterTaskKey.length > 256)) return err({ kind: "invalidTransition" });
    const now = this.clock();
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "storageFailure" });
    const found = await this.ledger.listStaffItems(scope, afterTaskKey);
    if (!found.ok) return found;
    if (found.value.length > 50 || found.value.some((entry, index) => !valid(entry) ||
        (afterTaskKey !== undefined && entry.taskKey <= afterTaskKey) ||
        (index > 0 && entry.taskKey <= found.value[index - 1]!.taskKey))) return err({ kind: "storageCorrupt" });
    const items = found.value.map(entry => ({ ...entry, overdue: entry.status !== "resolved" && Date.parse(entry.dueAt) <= Date.parse(now) }));
    return ok({ items, ...(items.length === 50 ? { nextAfterTaskKey: items[49]!.taskKey } : {}) });
  }

  /** Count at most 5,000 scoped items. Paging is bounded and is not an atomic snapshot. */
  async health(scope: LocationScope): Promise<Result<StaffQueueHealth, TransitionFailure>> {
    let observedAt: string;
    try { observedAt = this.clock(); }
    catch { return err({ kind: "storageFailure" }); }
    if (!Number.isFinite(Date.parse(observedAt))) return err({ kind: "storageFailure" });
    const queue = new StaffQueue(this.ledger, () => observedAt);
    const statuses = { requested: 0, open: 0, acknowledged: 0, resolved: 0, needsReview: 0, failed: 0 };
    const health = { scanned: 0, statuses, overdue: 0, reviewRequired: 0, pendingChange: 0,
      alertPending: 0, alertUncertain: 0, alertFailed: 0 };
    let afterTaskKey: string | undefined;
    for (let pageIndex = 0; pageIndex <= 100; pageIndex += 1) {
      const page = await queue.list(scope, afterTaskKey);
      if (!page.ok) return page;
      if (pageIndex === 100 && page.value.items.length > 0) return err({ kind: "storageFailure" });
      for (const item of page.value.items) {
        health.scanned += 1;
        health.statuses[item.status] += 1;
        if (item.overdue) health.overdue += 1;
        if (item.reviewRequired) health.reviewRequired += 1;
        if (item.pendingChangeKey) health.pendingChange += 1;
        for (const state of Object.values(item.alerts ?? {})) {
          if (state === "pending") health.alertPending += 1;
          if (state === "uncertain") health.alertUncertain += 1;
          if (state === "failed") health.alertFailed += 1;
        }
      }
      afterTaskKey = page.value.nextAfterTaskKey;
      if (!afterTaskKey) return ok({ observedAt, consistency: "nonAtomicScan", ...health });
    }
    return err({ kind: "storageFailure" });
  }
}
