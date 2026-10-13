import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import type { AppointmentHistoryApproval } from "../../src/standalone/owner-file-appointment-history-policy.ts";
import { servicePractitionerFixture } from "./service-practitioner-preference.ts";
import { verificationCanaries } from "./caller-verification.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export async function previousPractitionerFixture() {
  const f = await servicePractitionerFixture(); f.flow.dispose();
  const callerPath = join(f.folder, "history-caller.json"), path = join(f.folder, "history-policy.json");
  const caller = JSON.parse(await readFile(f.config.callerApprovalPath, "utf8"));
  await writeFile(callerPath, JSON.stringify({ ...caller, revision: "history-caller-1", operations: ["appointments.read"] }), { mode: 0o600 });
  const { scope, policyVersion, businessId, credentialFingerprint, timeZone, approverRef, approvedAt, effectiveFrom, effectiveUntil } = f.approval;
  let approval: AppointmentHistoryApproval = { scope, policyVersion, businessId, credentialFingerprint, timeZone, approverRef, approvedAt, effectiveFrom, effectiveUntil,
    approved: true, enabled: true, revision: "history-1", lookBackDays: 3650, purpose: "previousPractitioner" };
  const replace = async () => { await writeFile(`${path}.next`, JSON.stringify(approval), { mode: 0o600 }); await rename(`${path}.next`, path); };
  await replace();
  const base = "https://api.au5.cliniko.com/v1";
  const row = (id: string, practitioner = "23", start = "2026-10-01T04:00:00.000Z") => ({ id, starts_at: start, ends_at: new Date(Date.parse(start) + 3600000).toISOString(),
    cancelled_at: null, archived_at: null, deleted_at: null, did_not_arrive: false, notes: verificationCanaries[1],
    patient: { links: { self: `${base}/patients/${verificationCanaries[2]}` } }, business: { links: { self: `${base}/businesses/11` } },
    practitioner: { links: { self: `${base}/practitioners/${practitioner}` } } });
  let rows: Record<string, unknown>[] = [row("71"), row("70", "22", "2026-09-20T04:00:00.000Z")], reads = 0, failure = false, allowed = true, candidate = verificationCanaries[2]!;
  let onRead: () => Promise<void> = async () => undefined;
  const queries: string[][] = [], traffic: string[] = [], permissions: string[] = [], original = f.flowConfig.fetchPort!;
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)); traffic.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v1/individual_appointments" && url.searchParams.get("sort") === "starts_at:desc") {
      reads++; queries.push(url.searchParams.getAll("q[]")); await onRead();
      return failure ? new Response(null, { status: 503 }) : Response.json({ total_entries: rows.length, individual_appointments: rows.slice((Number(url.searchParams.get("page")) - 1) * 100, Number(url.searchParams.get("page")) * 100) });
    }
    return original(value, init);
  };
  const config = { ...f.flowConfig, fetchPort, lookup: { candidates: async (...args: Parameters<typeof f.flowConfig.lookup.candidates>) => {
    const original = await f.flowConfig.lookup.candidates(...args); return candidate === verificationCanaries[2] ? original : { ok: true as const, value: { kind: "one" as const, candidateIds: [candidate] } };
  } }, permission: { allows: async (...args: Parameters<typeof f.flowConfig.permission.allows>) => { permissions.push(args[2]); return f.flowConfig.permission.allows(...args); } },
    history: { callerApprovalPath: callerPath, historyApprovalPath: path, permission: { allows: async (_scope: unknown, patient: string, operation: string) => {
      permissions.push(operation); return allowed && patient === verificationCanaries[2] && operation === "appointments.read";
    } } } };
  const flow = resultValue(ClinikoCallFlow.create(config));
  return { ...f, flow, flowConfig: config, historyPath: path, historyApproval: approval, row, queries, traffic, permissions,
    get historyReads() { return reads; }, setRows: (value: Record<string, unknown>[]) => { rows = value; }, setFailure: (value = true) => { failure = value; },
    setPermission: (value: boolean) => { allowed = value; }, setCandidate: (value: string) => { candidate = value; }, setOnHistoryRead: (work: () => Promise<void>) => { onRead = work; },
    replaceHistory: async (patch: Partial<AppointmentHistoryApproval>) => { approval = { ...approval, ...patch }; await replace(); },
    close: async () => { flow.dispose(); await f.close(); } };
}
