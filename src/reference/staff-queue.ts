import type { LedgerStore } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result, StaffQueueEntry, TransitionFailure } from "../core/model.ts";

export type StaffQueuePage = Readonly<{
  items: readonly Readonly<StaffQueueEntry & { overdue: boolean }>[];
  nextAfterTaskKey?: string;
}>;

const reasons = ["callerRequested", "verificationFailed", "unsupported", "uncertainAction", "partialIntake", "systemFailure", "transferFailed"];
const statuses = ["requested", "open", "needsReview", "failed"];

function valid(entry: StaffQueueEntry): boolean {
  return typeof entry.callId === "string" && !!entry.callId && typeof entry.taskKey === "string" && !!entry.taskKey &&
    reasons.includes(entry.reason) && statuses.includes(entry.status) &&
    typeof entry.dueAt === "string" && Number.isFinite(Date.parse(entry.dueAt)) &&
    !!entry.destination && (entry.destination.kind === "owner" ?
      typeof entry.destination.ownerRef === "string" && !!entry.destination.ownerRef :
      entry.destination.kind === "queue" && typeof entry.destination.queueRef === "string" && !!entry.destination.queueRef) &&
    (entry.linkedActionKey === undefined || typeof entry.linkedActionKey === "string") &&
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
    const items = found.value.map(entry => ({ ...entry, overdue: Date.parse(entry.dueAt) <= Date.parse(now) }));
    return ok({ items, ...(items.length === 50 ? { nextAfterTaskKey: items[49]!.taskKey } : {}) });
  }
}
