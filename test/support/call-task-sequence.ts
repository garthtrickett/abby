import assert from "node:assert/strict";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ClinikoCallFlowConfig } from "../../src/standalone/cliniko-call-flow.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";

export async function syntheticTaskSequence(config: ClinikoCallFlowConfig, folder: string, maximumTasks = 2) {
  const path = join(folder, "call-tasks.json"), approval = {
    scope: config.receipt.scope, revision: "tasks-1", approverRef: "synthetic-admin", approved: true, enabled: true,
    approvedAt: "2026-10-04T05:59:00.000Z", effectiveFrom: "2026-10-04T05:59:00.000Z", effectiveUntil: "2026-10-05T06:00:00.000Z",
    policyVersion: config.policyVersion, businessId: config.cliniko.businessId, credentialFingerprint: clinikoCredentialFingerprint(config.cliniko.apiKey),
    timeZone: config.cliniko.timeZone, maximumTasks, operations: ["book", "cancel", "reschedule", "patientUpdate", "confirmationResend", "appointments.read"],
    patientSelection: "sameVerifiedCaller", verification: "freshEachTask", unresolvedActions: "denyNextTask",
  };
  const replace = async (patch: Record<string, unknown> = {}) => {
    await writeFile(`${path}.new`, JSON.stringify({ ...approval, ...patch }), { mode: 0o600 }); await rename(`${path}.new`, path);
  };
  await replace(); return { config: { ...config, taskSequence: { approvalPath: path } }, path, replace };
}

/** Independent native appointment records for repeated task fixtures. The single-task
 * fixture retains its original assertions and behavior. */
export function syntheticMultiTaskBookingProvider() {
  const rows = new Map<string, Record<string, unknown>>(), requests: Record<string, unknown>[] = [];
  let fault = false; let afterReview: () => Promise<void> = async () => undefined;
  const wrap = (base: typeof fetch): typeof fetch => async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    if (method === "POST" && url.pathname === "/v1/individual_appointments") {
      const body = JSON.parse(String(init?.body)), id = String(91 + requests.length); requests.push(body);
      const link = (family: string, id: string) => ({ links: { self: `https://api.au5.cliniko.com/v1/${family}/${id}` } });
      const row = { id, starts_at: body.starts_at, ends_at: new Date(Date.parse(body.starts_at) + 30 * 60_000).toISOString(),
        cancelled_at: null, archived_at: null, deleted_at: null, notes: body.notes,
        business: link("businesses", body.business_id), practitioner: link("practitioners", body.practitioner_id),
        appointment_type: link("appointment_types", body.appointment_type_id), patient: link("patients", body.patient_id) };
      assert.equal([...rows.values()].some(previous => previous.cancelled_at === null && previous.starts_at === row.starts_at), false, "fresh availability cannot book an occupied time");
      rows.set(id, row); if (fault) throw new Error("synthetic lost booking response"); return Response.json(row, { status: 201 });
    }
    const id = /^\/v1\/individual_appointments\/([0-9]+)(?:\/conflicts)?$/.exec(url.pathname)?.[1];
    if (method === "GET" && id && rows.has(id)) return Response.json(url.pathname.endsWith("/conflicts") ? { conflicts: { exist: false } } : rows.get(id));
    const response = await base(value, init);
    if (method === "POST" && url.pathname === "/v1/recalls") {
      const row = await response.json(); row.id = String(701 + requests.length); await afterReview(); return Response.json(row, { status: response.status });
    }
    if (url.pathname.endsWith("/available_times") && response.status === 200) {
      const body = await response.json(); body.available_times = body.available_times.filter((time: { appointment_start: string }) =>
        ![...rows.values()].some(row => row.starts_at === time.appointment_start)); body.total_entries = body.available_times.length; return Response.json(body);
    }
    return response;
  };
  return { wrap, requests, rows, loseResponse: () => { fault = true; }, afterReview: (callback: () => Promise<void>) => { afterReview = callback; } };
}
