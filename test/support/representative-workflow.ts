import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import assert from "node:assert/strict";
import { bookingOffersFixture } from "./booking-offers.ts";
import { representativeFixture } from "./representative-selection.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { verificationNow } from "./caller-verification.ts";

export async function representativeWorkflowFixture(guardian = false) {
  const f = await bookingOffersFixture({ budget: new ClinikoReadBudget(200, () => Date.parse(verificationNow)) });
  const r = await representativeFixture(f.ownerPorts.rateBudget, { fixture: f, operation: "appointments.book" });
  await r.verifyActor();
  if (guardian) {
    r.identity.dateOfBirth = "2014-03-05"; r.patients.get("43")!.date_of_birth = r.identity.dateOfBirth;
    r.authorizations.set("43", { ...r.authorizations.get("43")!, subjectKind: "minor", authorityKind: "guardian" });
  }
  const selected = resultValue(await r.select());
  let revoked = false;
  const base = "https://api.au5.cliniko.com/v1", requests: { path: string; body: Record<string, unknown> }[] = [];
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    if (url.pathname === "/v1/recalls" && method === "POST") {
      const body = JSON.parse(String(init?.body)); requests.push({ path: url.pathname, body });
      assert.equal(body.patient_id, "43");
      const row = { id: "71", archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes,
        patient: { links: { self: `${base}/patients/${body.patient_id}` } }, recall_type: { links: { self: `${base}/recall_types/7` } } };
      f.recalls.push(row); return Response.json(row, { status: 201 });
    }
    if (url.pathname === "/v1/individual_appointments" && method === "POST") {
      const body = JSON.parse(String(init?.body)); requests.push({ path: url.pathname, body }); assert.equal(body.patient_id, "43");
    }
    if (url.pathname === "/v1/patients/43") return Response.json(r.patients.get("43"));
    return f.ownerPorts.fetchPort(value, init);
  };
  const config = { receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
    ledger: f.ledger, policies: f.policies, lookup: f.sessionConfig.lookup,
    permission: { allows: async (_scope: unknown, patientId: string) => patientId === "43" && !revoked }, verificationBudget: { reserve: async () => true },
    delivery: r.config.delivery, directory: f.directory, callerApprovalPath: r.config.representativeCallerApprovalPath, bookingApprovalPath: f.path,
    representative: { owner: r.owner, selectionRef: selected.selectionRef },
    cliniko: r.config.cliniko, signal: r.lifetime.signal, fetchPort, clock: f.sessionConfig.clock };
  const close = async () => { await r.close(); };
  return { f, r, config, requests, close, revoke: () => { revoked = true; } };
}
