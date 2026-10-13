import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoContactRevision } from "../../src/storage/postgres-cliniko-contact-revision.ts";
import { ClinikoPatientCorrectionRecovery } from "../../src/standalone/cliniko-patient-correction-recovery.ts";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { encodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { callerVerificationFixture } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import type { HostActor } from "../../src/reference/command-gateway.ts";
import { createHostAuthenticatedDashboardServer } from "../../src/standalone/dashboard/server.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { DisabledStandaloneHost } from "../../src/standalone/disabled-host.ts";
import { once } from "node:events";
import { resolve } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });
async function fixture() {
  const f = await callerVerificationFixture();
  const apiKey = "synthetic-recovery-au5", fp = clinikoCredentialFingerprint(apiKey), alias = clinikoCredentialFingerprint("synthetic-second-au5");
  const contacts = new PostgresClinikoContactRevision(db, f.scope.tenantId, [alias, fp]);
  const correctionRef = crypto.randomUUID(); resultValue(await contacts.begin(correctionRef));
  const envelope = { scope: f.scope, patientId: "482746192837465", businessId: "11", credentialFingerprint: fp,
    policyVersion: "private-policy-canary", termsVersion: "private-terms-canary", timeZone: "Australia/Sydney", createdAt: "2026-10-04T06:00:00.000Z",
    operation: { kind: "patientUpdate" as const, correctionRef } };
  let row = { id: "91", archived_at: null, recalled: false, updated_at: "2026-10-04T06:00:01.000Z",
    notes: resultValue(encodeClinikoReview(crypto.randomUUID(), envelope)), links: { self: "https://api.au5.cliniko.com/v1/recalls/91" },
    patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/482746192837465" } },
    recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/7" } } };
  let actor: HostActor | null = f.account.actor, enabled = true, reviewed = false, stopped = false, reads = 0;
  let onRead = async () => {}, onPermission = async () => {};
  const reader = resultValue(ClinikoRecallReader.create({ scope: f.scope, apiKey, contactEmail: "test@example.test" }, async (input, init) => {
    assert.equal(String(input), "https://api.au5.cliniko.com/v1/recalls/91"); assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    reads++; const response = Response.json(row); await onRead(); return response;
  }));
  const recovery = new ClinikoPatientCorrectionRecovery({ scope: f.scope, businessId: "11", credentialFingerprint: fp, timeZone: "Australia/Sydney", recallTypeId: "7",
    reader, contacts, directory: f.config.directory, enabled: async () => enabled,
    authority: { currentActor: async () => actor, permitsReviewedResolution: async () => { await onPermission(); return reviewed && stopped; } } });
  return { f, contacts, fp, alias, correctionRef, recovery, request: { correctionRef, recallRef: "cliniko:recall:91", reviewAcknowledged: true as const },
    setActor: (value: HostActor | null) => { actor = value; }, enable: (value: boolean) => { enabled = value; },
    reviewed: (value: boolean) => { reviewed = value; }, stopped: (value: boolean) => { stopped = value; },
    patch: (patch: Partial<typeof row>) => { row = { ...row, ...patch }; },
    onRead: (callback: () => Promise<void>) => { onRead = callback; }, onPermission: (callback: () => Promise<void>) => { onPermission = callback; },
    get reads() { return reads; }, close: () => f.close() };
}

test("E2E-366 authenticated reviewed/quiescent resolution consumes only its linked block and keeps immutable attribution", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.recovery.resolve(f.request)).ok, false);
    f.patch({ recalled: true }); assert.equal((await f.recovery.resolve(f.request)).ok, false);
    f.reviewed(true); assert.equal((await f.recovery.resolve(f.request)).ok, false);
    f.stopped(true);
    const other = resultValue(await f.contacts.begin(crypto.randomUUID()));
    assert.deepEqual(await f.recovery.resolve(f.request), { ok: true, value: { kind: "contactReviewResolved", alreadyResolved: false } });
    assert.equal(resultValue(await f.contacts.read(f.fp)).blocked, true);
    assert.equal(resultValue(await f.contacts.read(f.alias)).blocked, true);
    assert.deepEqual(resultValue(await f.contacts.status(f.correctionRef)), { binding: "reviewBound", status: "completed", completionMethod: "staffReviewed", completedBy: f.f.account.actor.actorRef });
    const revision = resultValue(await f.contacts.read(f.fp)).version;
    assert.deepEqual(await f.recovery.resolve(f.request), { ok: true, value: { kind: "contactReviewResolved", alreadyResolved: true } });
    assert.equal(resultValue(await f.contacts.read(f.fp)).version, revision);
    assert.deepEqual(await f.contacts.begin(f.correctionRef), { ok: false, error: { kind: "contactChanged" } });
    resultValue(await f.contacts.complete(other));
    const metadata = await sql<Record<string, unknown>>`select * from cliniko_contact_change_registry where tenant_id = ${f.f.scope.tenantId}`.execute(db);
    assert.deepEqual(Object.keys(metadata.rows[0]!).sort(), ["binding", "change_ref", "completed_at", "completed_by", "completion_method", "created_at", "fingerprints", "status", "tenant_id"]);
    for (const canary of ["482746192837465", "private-policy-canary", "private-terms-canary"]) assert.equal(JSON.stringify(metadata.rows).includes(canary), false);
  } finally { await f.close(); }
});

test("E2E-366 absent, agent/staff, wrong-scope and revoked admin authority cannot read native review or clear a block", async () => {
  const f = await fixture();
  try {
    const actor = f.f.account.actor;
    for (const changed of [null, { ...actor, role: "agent" as const }, { ...actor, role: "staff" as const }, { ...actor, scope: { ...actor.scope, locationId: "other" } }]) {
      f.setActor(changed); assert.equal((await f.recovery.resolve(f.request)).ok, false);
    }
    f.setActor(actor); f.enable(false); assert.equal((await f.recovery.resolve(f.request)).ok, false);
    f.enable(true); f.patch({ recalled: true }); f.reviewed(true); f.stopped(true);
    f.onPermission(async () => { f.setActor(null); });
    assert.equal((await f.recovery.resolve(f.request)).ok, false);
    assert.equal(f.reads, 1); assert.equal(resultValue(await f.contacts.read(f.fp)).blocked, true);
  } finally { await f.close(); }
});

test("E2E-366 native edits, wrong links, malformed requests and unlinked legacy references retain their blocks", async () => {
  for (const fault of ["nativeEdited", "patientLink", "injectedRole", "unacknowledged", "legacy"] as const) {
    const f = await fixture();
    try {
      f.patch({ recalled: true }); f.reviewed(true); f.stopped(true);
      if (fault === "nativeEdited") f.onRead(async () => { f.patch({ updated_at: "2026-10-04T06:00:02.000Z" }); });
      if (fault === "patientLink") f.patch({ patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/999" } } });
      const request = fault === "injectedRole" ? { ...f.request, actorRef: "forged-admin" } : fault === "unacknowledged"
        ? { ...f.request, reviewAcknowledged: false } : fault === "legacy" ? { ...f.request, correctionRef: resultValue(await f.contacts.begin()) } : f.request;
      assert.equal((await f.recovery.resolve(request as typeof f.request)).ok, false);
      assert.equal(resultValue(await f.contacts.read(f.fp)).blocked, true);
    } finally { await f.close(); }
  }
});

test("E2E-366 authenticated operator HTTP surface rejects roles, injected identity, cross-origin and setup-only recovery", async () => {
  const f = await fixture();
  let actor: HostActor = f.f.account.actor, factories = 0;
  const server = await createHostAuthenticatedDashboardServer({ publicOrigin: "http://127.0.0.1:0", resolveActor: () => actor,
    gatewayFor: bound => new CommandGateway(bound, f.f.policies, new TextReception(f.f.ledger, f.f.policies, new DisabledStandaloneHost())),
    correctionRecoveryFor: () => { factories++; return f.recovery; } }, resolve("dist/dashboard/app.js"));
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`, endpoint = `${origin}/api/patient-corrections/resolve-reviewed`;
    const post = (body: unknown, suppliedOrigin = origin) => fetch(endpoint, { method: "POST", headers: { Origin: suppliedOrigin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    actor = { ...actor, role: "agent" }; assert.equal((await post(f.request)).status, 403); assert.equal(factories, 0);
    actor = f.f.account.actor;
    assert.equal((await post({ ...f.request, actorRef: actor.actorRef })).status, 400);
    assert.equal((await post(f.request, "https://unapproved.example.test")).status, 403);
    assert.equal(factories, 0);
    f.patch({ recalled: true }); f.reviewed(true); f.stopped(true);
    const response = await post(f.request); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, value: { kind: "contactReviewResolved", alreadyResolved: false } });
    assert.equal(factories, 1);
    assert.equal(resultValue(await f.contacts.read(f.fp)).blocked, false);
    const setup = await createHostAuthenticatedDashboardServer({ publicOrigin: "http://127.0.0.1:0", surface: "availabilitySetup",
      resolveActor: () => actor,
      gatewayFor: bound => new CommandGateway(bound, f.f.policies, new TextReception(f.f.ledger, f.f.policies, new DisabledStandaloneHost())),
      correctionRecoveryFor: () => { factories++; return f.recovery; } }, resolve("dist/dashboard/app.js"));
    try {
      setup.listen(0, "127.0.0.1"); await once(setup, "listening");
      const setupAddress = setup.address(); assert.ok(setupAddress && typeof setupAddress !== "string");
      const setupOrigin = `http://127.0.0.1:${setupAddress.port}`;
      const denied = await fetch(`${setupOrigin}/api/patient-corrections/resolve-reviewed`, { method: "POST",
        headers: { Origin: setupOrigin, "Content-Type": "application/json" }, body: JSON.stringify(f.request) });
      assert.equal(denied.status, 404); assert.equal(factories, 1);
    } finally { setup.closeAllConnections(); await new Promise<void>(resolve => setup.close(() => resolve())); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});
