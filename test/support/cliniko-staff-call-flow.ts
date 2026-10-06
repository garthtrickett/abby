import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { StaffApproval } from "../../src/standalone/owner-file-staff-policy.ts";
import { bookingCallFlowFixture } from "./cliniko-call-flow.ts";
import { verificationCanaries } from "./caller-verification.ts";

/** Independent synthetic staff permission, accepted queue process, mail and
 * provider responses. Every request still crosses the actual verification,
 * SAM outbox and Cliniko recall writer. No actual clinic activation. */
export async function clinikoStaffCallFlowFixture(options: { lostResponse?: boolean; nonCommitted?: boolean; approved?: boolean; malformed?: boolean } = {}) {
  const f = await bookingCallFlowFixture();
  try {
    const callerApprovalPath = join(f.folder, "staff-caller.json"), staffApprovalPath = join(f.folder, "staff-process.json");
    const caller = JSON.parse(await readFile(f.config.callerApprovalPath, "utf8"));
    caller.operations = ["staff.request"];
    await writeFile(callerApprovalPath, JSON.stringify(caller), { mode: 0o600 });
    const approval: StaffApproval = { scope: f.scope, revision: "synthetic-staff-1", approverRef: "synthetic-admin",
      approvedAt: caller.approvedAt, effectiveFrom: caller.effectiveFrom, effectiveUntil: caller.effectiveUntil,
      approved: options.approved ?? true, enabled: true, policyVersion: f.flowConfig.policyVersion,
      businessId: "11", recallTypeId: "8", timeZone: "Australia/Sydney", credentialFingerprint: clinikoCredentialFingerprint(f.config.cliniko.apiKey),
      reviewProcess: "clinikoRecallsFullType", reviewOwnerRef: "synthetic-review-owner", reviewBackupRef: "synthetic-review-backup",
      reviewCadenceMinutes: 30, staffLabels: ["Morgan"] };
    await writeFile(staffApprovalPath, JSON.stringify(approval), { mode: 0o600 });
    const recalls: Record<string, unknown>[] = [], traffic: string[] = [];
    let permitted = true, posts = 0;
    const fetchPort: typeof fetch = async (value, init) => {
      const url = new URL(String(value)), method = init?.method ?? "GET";
      traffic.push(`${method} ${url.pathname}`);
      if (url.pathname !== "/v1/recalls") return f.flowConfig.fetchPort!(value, init);
      if (method === "GET") return Response.json({ recalls, total_entries: recalls.length });
      if (method !== "POST") throw new Error("unexpected synthetic staff method");
      posts++;
      const body = JSON.parse(String(init?.body));
      const base = "https://api.au5.cliniko.com/v1";
      const row = { id: "81", notes: body.notes, recalled: false, archived_at: null, recall_at: body.recall_at,
        patient: { links: { self: `${base}/patients/${body.patient_id}` } }, recall_type: { links: { self: `${base}/recall_types/${body.recall_type_id}` } } };
      if (!options.nonCommitted) recalls.push(row);
      if (options.lostResponse || options.nonCommitted) throw new Error("synthetic lost staff response");
      return Response.json(options.malformed ? { ...row, patient: { links: { self: `${base}/patients/43` } } } : row, { status: 201 });
    };
    const permissions: string[] = [];
    const config = { ...f.flowConfig, fetchPort, staff: { callerApprovalPath, staffApprovalPath, recallTypeId: "8",
      permission: { allows: async (_scope: unknown, patientId: string, operation: string) => {
        permissions.push(operation); return permitted && patientId === verificationCanaries[2] && operation === "staff.request";
      } } } };
    return { ...f, flowConfig: config, staffApproval: approval, recalls, traffic, permissions,
      get staffPosts() { return posts; }, denyStaffPermission: () => { permitted = false; },
      replaceStaffApproval: async (patch: Partial<StaffApproval>) => { await writeFile(staffApprovalPath, JSON.stringify({ ...approval, ...patch }), { mode: 0o600 }); } };
  } catch (error) { await f.close(); throw error; }
}
