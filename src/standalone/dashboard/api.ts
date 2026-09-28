import { err, ok } from "../../core/model.ts";
import type { CallPolicy, Result, StaffChangeRequest, StaffQueueEntry } from "../../core/model.ts";
import type { CallSummary } from "../../reference/call-review.ts";
import type { CapabilityDescriptor, GatewayFailure } from "../../reference/command-gateway.ts";
import type { StaffQueuePage } from "../../reference/staff-queue.ts";

export type DashboardFailure = GatewayFailure | Readonly<{ kind: "transportUnavailable" | "malformed" }>;
export type DashboardPort = Readonly<{
  capabilities(): Promise<Result<readonly CapabilityDescriptor[], DashboardFailure>>;
  settings(): Promise<Result<CallPolicy, DashboardFailure>>;
  changeBookingEnabled(expectedVersion: string, enabled: boolean): Promise<Result<CallPolicy, DashboardFailure>>;
  callSummary(callId: string): Promise<Result<CallSummary, DashboardFailure>>;
  staffQueue(afterTaskKey?: string): Promise<Result<StaffQueuePage, DashboardFailure>>;
  changeStaff(item: StaffQueueEntry, change: StaffChangeRequest): Promise<Result<void, DashboardFailure>>;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function request(path: string, init?: RequestInit): Promise<Result<unknown, DashboardFailure>> {
  try {
    const response = await fetch(path, init);
    const data = record(await response.json() as unknown);
    if (!data) return err({ kind: "malformed" });
    if (data.ok === false) {
      const failure = record(data.error);
      return typeof failure?.kind === "string" ? err(failure as DashboardFailure) : err({ kind: "malformed" });
    }
    return data.ok === true ? ok(data.value) : err({ kind: "malformed" });
  } catch {
    return err({ kind: "transportUnavailable" });
  }
}

function policy(value: unknown): Result<CallPolicy, DashboardFailure> {
  const reply = record(value);
  const current = record(reply?.policy);
  return reply?.kind === "settings" && current && typeof current.policyVersion === "string" && typeof current.bookingEnabled === "boolean" && record(current.capabilities)
    ? ok(current as CallPolicy) : err({ kind: "malformed" });
}

export class FetchDashboardPort implements DashboardPort {
  async capabilities(): Promise<Result<readonly CapabilityDescriptor[], DashboardFailure>> {
    const result = await request("/api/capabilities");
    if (!result.ok) return result;
    if (!Array.isArray(result.value) || !result.value.every(item => typeof record(item)?.id === "string")) return err({ kind: "malformed" });
    return ok(result.value as readonly CapabilityDescriptor[]);
  }

  async settings(): Promise<Result<CallPolicy, DashboardFailure>> {
    const result = await request("/api/settings");
    return result.ok ? policy(result.value) : result;
  }

  async changeBookingEnabled(expectedVersion: string, enabled: boolean): Promise<Result<CallPolicy, DashboardFailure>> {
    const result = await request("/api/settings/booking-enabled", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion, enabled }),
    });
    return result.ok ? policy(result.value) : result;
  }

  async callSummary(callId: string): Promise<Result<CallSummary, DashboardFailure>> {
    const result = await request(`/api/calls/${encodeURIComponent(callId)}`);
    if (!result.ok) return result;
    const reply = record(result.value);
    const call = record(reply?.call);
    return reply?.kind === "callSummary" && call && call.callId === callId &&
      (call.lifecycle === "starting" || call.lifecycle === "active" || call.lifecycle === "ended") &&
      Array.isArray(call.actions) && Array.isArray(call.staffItems)
      ? ok(call as CallSummary) : err({ kind: "malformed" });
  }

  async staffQueue(afterTaskKey?: string): Promise<Result<StaffQueuePage, DashboardFailure>> {
    const result = await request(`/api/staff${afterTaskKey === undefined ? "" : `?after=${encodeURIComponent(afterTaskKey)}`}`);
    if (!result.ok) return result;
    const reply = record(result.value);
    const page = record(reply?.page);
    return reply?.kind === "staffQueue" && page && Array.isArray(page.items) && page.items.every(item => {
      const entry = record(item);
      return entry && typeof entry.callId === "string" && Number.isSafeInteger(entry.callVersion) && typeof entry.taskKey === "string" &&
        typeof entry.reason === "string" && typeof entry.status === "string" && typeof entry.dueAt === "string" &&
        typeof entry.overdue === "boolean";
    }) && (page.nextAfterTaskKey === undefined || typeof page.nextAfterTaskKey === "string")
      ? ok(page as StaffQueuePage) : err({ kind: "malformed" });
  }

  async changeStaff(item: StaffQueueEntry, change: StaffChangeRequest): Promise<Result<void, DashboardFailure>> {
    const result = await request("/api/staff/change", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callId: item.callId, taskKey: item.taskKey, expectedVersion: item.callVersion, change }) });
    if (!result.ok) return result;
    const reply = record(result.value);
    return reply?.kind === "staffChange" && reply.taskKey === item.taskKey && Number.isSafeInteger(reply.callVersion) &&
      typeof reply.status === "string" && typeof reply.pending === "boolean" && typeof reply.reviewRequired === "boolean"
      ? ok(undefined) : err({ kind: "malformed" });
  }
}
