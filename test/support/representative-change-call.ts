import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import type { HostWriteReceipt } from "../../src/core/model.ts";
import { representativeCallOwnerFixture, representativeInputOptions } from "./representative-call-owner.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { verificationCanaries, verificationNow } from "./caller-verification.ts";

/** Native-shaped synthetic changes. All operations retain the same actual
 * shared account budget, independent caller/subject permissions and SAM. */
export async function representativeChangeCallFixture(operation: "cancel" | "reschedule" | "appointments.read" = "cancel") {
  const f = await representativeCallOwnerFixture({ multiplePatients: true, operation, appointmentChanges: true,
    allowedOperations: ["book", "cancel", "reschedule", "appointments.read"] }); f.flow.dispose();
  const base = "https://api.au5.cliniko.com/v1", rows = new Map<string, Record<string, unknown>>();
  const link = (kind: string, id: string) => ({ links: { self: `${base}/${kind}/${id}` } });
  for (const [id, patientId, hour] of [["91", "43", "04"], ["92", "44", "05"], ["93", verificationCanaries[2]!, "06"]] as const)
    rows.set(id, { id, starts_at: `2026-10-08T${hour}:00:00.000Z`, ends_at: `2026-10-08T${hour}:30:00.000Z`,
      cancelled_at: null, archived_at: null, deleted_at: null, notes: "synthetic appointment change",
      patient: link("patients", patientId), business: link("businesses", "11"), practitioner: link("practitioners", "22"), appointment_type: link("appointment_types", "33") });
  const original = f.flowConfig.fetchPort, patches: { id: string; kind: "cancel" | "reschedule"; body: Record<string, unknown> }[] = [];
  let lostWrite = false;
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    if (url.pathname === "/v1/individual_appointments" && method === "GET") {
      const patientId = url.searchParams.getAll("q[]").map(filter => /^patient_id:=(\d+)$/.exec(filter)?.[1]).find(Boolean); assert.ok(patientId);
      const appointments = [...rows.values()].filter(row => (row.patient as { links: { self: string } }).links.self === `${base}/patients/${patientId}` && row.cancelled_at === null);
      return Response.json({ total_entries: appointments.length, individual_appointments: appointments });
    }
    const id = /^\/v1\/individual_appointments\/([0-9]+)(?:\/(?:cancel|conflicts))?$/.exec(url.pathname)?.[1];
    if (id && rows.has(id)) {
      if (url.pathname.endsWith("/conflicts")) return Response.json({ conflicts: { exist: false } });
      const row = rows.get(id)!;
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body));
        const kind = url.pathname.endsWith("/cancel") ? "cancel" : "reschedule";
        patches.push({ id, kind, body });
        if (kind === "cancel") { assert.equal(body.cancellation_reason, 50); row.cancelled_at = verificationNow; }
        else { assert.equal(body.ends_at, null); row.starts_at = body.starts_at; row.ends_at = new Date(Date.parse(String(body.starts_at)) + 30 * 60_000).toISOString(); }
        if (lostWrite) throw new Error("synthetic lost related-person change response");
        return kind === "cancel" ? new Response(null, { status: 204 }) : Response.json(row);
      }
      assert.equal(method, "GET"); return Response.json(row);
    }
    if (url.pathname === "/v1/recalls" && method === "POST") {
      const body = JSON.parse(String(init?.body)); assert.ok(["43", "44"].includes(body.patient_id));
      const row = { id: String(701 + f.f.recalls.length), archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes,
        patient: link("patients", body.patient_id), recall_type: link("recall_types", "7") };
      f.f.recalls.push(row); return Response.json(row, { status: 201 });
    }
    return original(value, init);
  };
  const caller = JSON.parse(await readFile(f.callerPath, "utf8"));
  const common = Object.fromEntries(["scope", "revision", "approverRef", "approvedAt", "effectiveFrom", "effectiveUntil", "approved", "enabled"].map(key => [key, caller[key]]));
  const binding = { ...common, policyVersion: f.flowConfig.policyVersion, businessId: "11", credentialFingerprint: clinikoCredentialFingerprint(f.flowConfig.cliniko.apiKey),
    recallTypeId: "7", timeZone: "Australia/Sydney", writeContract: "bestEffort", notificationOwner: "cliniko", lateNoticeHours: 24, maxAdvanceDays: 30 };
  const cancelPath = join(f.f.folder, "related-cancel.json"), movePath = join(f.f.folder, "related-move.json");
  await writeFile(cancelPath, JSON.stringify({ ...binding, cancellationReason: 50,
    standardTerms: { version: "cancel-normal-1", approvedText: "No fee applies to this cancellation." }, lateTerms: { version: "cancel-late-1", approvedText: "A late cancellation fee applies." } }), { mode: 0o600 });
  await writeFile(movePath, JSON.stringify({ ...binding,
    standardTerms: { version: "move-normal-1", approvedText: "No fee applies to this move." }, lateTerms: { version: "move-late-1", approvedText: "A late rescheduling fee applies." } }), { mode: 0o600 });
  const flowConfig = { ...f.flowConfig, fetchPort, representativeInput: representativeInputOptions(f),
    approvals: { ...f.flowConfig.approvals, cancellation: cancelPath, rescheduling: movePath } };
  const flow = resultValue(ClinikoCallFlow.create(flowConfig));
  const nativeWrite = flow.write.bind(flow);
  let writesStarted = 0, writesSettled = 0, writeStartedAt: number | undefined, writeSettledAt: number | undefined;
  let writeSignal: AbortSignal | undefined, writeReceipt: HostWriteReceipt["kind"] | "pending" | "threw" = "pending";
  flow.write = async (...args: Parameters<ClinikoCallFlow["write"]>) => {
    writesStarted++; writeStartedAt = performance.now(); writeSettledAt = undefined; writeSignal = args[2]; writeReceipt = "pending";
    try { const receipt = await nativeWrite(...args); writeReceipt = receipt.kind; return receipt; }
    catch (error) { writeReceipt = "threw"; throw error; }
    finally { writesSettled++; writeSettledAt = performance.now(); }
  };
  return { ...f, flow, flowConfig, rows, patches, loseResponse: () => { lostWrite = true; },
    // Fixed counters and timings only. No names, provider rows, proof values,
    // native identifiers, approval contents or callback messages are exposed.
    writeDiagnostics: () => ({ writesStarted, writesSettled, writeReceipt,
      writeElapsedMs: writeStartedAt === undefined ? 0 : Math.round((writeSettledAt ?? performance.now()) - writeStartedAt),
      signalAborted: writeSignal?.aborted === true, nativeClaims: f.f.claims, appointmentPatches: patches.length, reviews: f.f.recalls.length }),
    close: async () => { flow.dispose(); await f.close(); } };
}
