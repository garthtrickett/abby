import { once } from "node:events";
import { resolve } from "node:path";
import { createHostAuthenticatedDashboardServer } from "../../src/standalone/dashboard/server.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import type { HostActor } from "../../src/reference/command-gateway.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { DisabledStandaloneHost } from "../../src/standalone/disabled-host.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { encodeClinikoReview } from "../../src/cliniko/review-request.ts";
import type { TenantConfigArchiveData } from "../../src/portability/config-archive.ts";
import { decodeTenantConfigArchive } from "../../src/portability/config-archive.ts";
import { ClinikoConfirmationResendRecovery } from "../../src/standalone/cliniko-confirmation-resend-recovery.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { createDisposablePostgres } from "../support/disposable-postgres.ts";
import { buildPostgresTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresConfirmationResendJournal } from "../../src/storage/postgres-confirmation-resend-journal.ts";
import { PostgresConfirmationResendImportHistory } from "../../src/storage/postgres-confirmation-resend-import-history.ts";
import { readConfirmationResendCarryover, reconcileConfirmationResendCarryover } from "../../src/storage/postgres-confirmation-resend-carryover.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { confirmationResendFixture } from "../support/confirmation-resend.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";

const database = await createDisposablePostgres();
const { db } = database;
after(async () => { await database.close(); });
const exporter = { authorizeAndRecord: async () => ok({ requestRef: "synthetic-reviewed-export" }) };
const importerAuthority = { authorizeAndRecord: async () => ok({ auditRef: "synthetic-reviewed-import" }) };
const binding = "b".repeat(64);
async function fixture(smtp: Parameters<typeof confirmationResendFixture>[1], hops = 1, status = "accepted") {
  const f = await confirmationResendFixture(db, smtp, "appointments.resend", true);
  try {
    const origin = { tenantId: `original-resend-${randomUUID()}`, clinicId: "old-clinic", locationId: "old-location" }, requestRef = randomUUID();
    const journal = new PostgresConfirmationResendJournal(db, origin, binding);
    resultValue(await journal.claim(requestRef));
    if (status === "accepted" || status === "wrongMessage") resultValue(await journal.finish(requestRef, { kind: "accepted", messageRef: status === "accepted" ? requestRef : randomUUID() }));
    if (status === "unknown" || status === "definitiveUnsent") resultValue(await journal.finish(requestRef, { kind: status }));
    resultValue(await new PostgresPolicyStore(db, referenceDefaultPolicy).changeBookingEnabled(origin, "0", false, "synthetic-owner"));
    let scope = origin; let archiveData: TenantConfigArchiveData | undefined;
    for (let i = 0; i < hops; i++) {
      const target = i === hops - 1 ? f.scope : { tenantId: `intermediate-resend-${randomUUID()}`, clinicId: "mid-clinic", locationId: "mid-location" };
      const archive = resultValue(await buildPostgresTenantConfigArchive(db, { sourceTenantId: scope.tenantId,
        archiveId: `resend-transfer-${randomUUID()}`, actorRef: "synthetic-owner", createdAt: "2026-10-14T04:00:00.000Z",
        locations: [{ sourceScope: scope, targetScope: target, timeZone: "Australia/Sydney", mappingProvenance: "reviewed" }] }, exporter));
      archiveData = resultValue(await decodeTenantConfigArchive(archive, target.tenantId));
      resultValue(await new PostgresTenantConfigArchiveImporter(db).stage(archive, target.tenantId, "synthetic-buyer", importerAuthority, { mapRef: () => "disabled" }));
      scope = target;
    }
    assert.ok(archiveData);
    const envelope = { scope: origin, patientId: verificationCanaries[2]!, businessId: "11", credentialFingerprint: clinikoCredentialFingerprint(f.config.cliniko.apiKey),
      policyVersion: "older-policy", termsVersion: binding, timeZone: "Australia/Sydney", createdAt: f.sessionConfig.clock(),
      operation: { kind: "confirmationResend" as const, resendRef: requestRef, appointmentId: "81", practitionerId: "22", appointmentTypeId: "33",
        startsAt: "2026-10-08T04:00:00.000Z", endsAt: "2026-10-08T04:30:00.000Z" } };
    let row = { id: "91", archived_at: null, recalled: true, updated_at: "2026-10-04T06:00:00.000Z",
      notes: resultValue(encodeClinikoReview(randomUUID(), envelope)), links: { self: "https://api.au5.cliniko.com/v1/recalls/91" },
      patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${verificationCanaries[2]}` } }, recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/7" } } };
    let reads = 0, permitted = true, onRead = async () => {}, factoryFault = "";
    const fetchPort: typeof fetch = async (_url, init) => { assert.equal(init?.method, "GET"); reads++;
      const response = Response.json(row); await onRead(); return response; };
    const reader = resultValue(ClinikoRecallReader.create({ scope: f.scope, apiKey: f.config.cliniko.apiKey, contactEmail: "test@example.test" }, fetchPort));
    const importHistory = new PostgresConfirmationResendImportHistory(db, f.scope);
    const config = { scope: f.scope, businessId: "11", credentialFingerprint: envelope.credentialFingerprint, timeZone: "Australia/Sydney", recallTypeId: "7",
      reader, policy: f.config.policy, directory: new OwnerFileAdminDirectory(f.accountPath, f.scope),
      journalFor: (hash: string) => new PostgresConfirmationResendJournal(db, f.scope, hash),
      authority: { currentActor: async () => f.account.actor, permitsReceiptInspection: async (_actor: unknown, review: { envelope: { request: { scope: unknown } } }) => {
        if (!permitted) return false; assert.deepEqual(review.envelope.request.scope, origin); return true; } },
      importHistory, readerForOrigin: (source: typeof origin) => resultValue(ClinikoRecallReader.create({
        scope: factoryFault === "scope" ? f.scope : source, apiKey: factoryFault === "account" ? "different-au5" : f.config.cliniko.apiKey, contactEmail: "test@example.test" }, fetchPort)) };
    return { f, origin, archiveData, config, importHistory, recovery: new ClinikoConfirmationResendRecovery(config), request: { requestRef, recallRef: "cliniko:recall:91" },
      journal: new PostgresConfirmationResendJournal(db, f.scope, binding), permit: (next: boolean) => { permitted = next; },
      fault: (next: string) => { factoryFault = next; }, onRead: (run: () => Promise<void>) => { onRead = run; },
      patch: (patch: Partial<typeof row>) => { row = { ...row, ...patch }; }, get reads() { return reads; } };
  } catch (error) { await f.close(); throw error; }
}

test("E2E-379 staff recovery resolves original native scope after one, two and three reviewed transfers", async () => {
  for (const hops of [1, 2, 3]) await withSmtpVerificationServer(async smtp => {
    const f = await fixture(smtp.config, hops);
    try {
      const nativeBefore = await readConfirmationResendCarryover(db, f.f.scope.tenantId);
      const provenance = resultValue(await f.importHistory.lookup(f.request.requestRef, new AbortController().signal));
      assert.ok(provenance); assert.deepEqual(provenance.sourceScope, f.origin); assert.deepEqual(provenance.targetScope, f.f.scope);
      if (hops > 1) assert.deepEqual(f.archiveData.locations[0]!.confirmationResends![0]!.originScope, f.origin);
      assert.equal(await reconcileConfirmationResendCarryover(db, f.archiveData), true);
      const result = resultValue(await f.recovery.inspect(f.request)); assert.equal(result.kind, "acceptedByMailService");
      assert.equal(result.reviewAcknowledged, true); assert.equal(f.reads, 2); assert.match(result.message, /Inbox delivery has not been verified/);
      assert.deepEqual(await readConfirmationResendCarryover(db, f.f.scope.tenantId), nativeBefore);
      assert.equal(resultValue(await f.journal.claim(f.request.requestRef)).send, false);
      for (const canary of [...verificationCanaries, f.origin.tenantId, f.origin.clinicId, f.origin.locationId, f.request.requestRef]) assert.equal(JSON.stringify(result).includes(canary), false);
      assert.equal(smtp.commands.length, 0); assert.equal(f.f.recalls.length, 0);
    } finally { await f.f.close(); }
  });
});

test("E2E-379 imported pending, unknown, unsent and contradictory receipts remain conservative", async () => {
  for (const status of ["pending", "unknown", "definitiveUnsent", "wrongMessage"]) await withSmtpVerificationServer(async smtp => {
    const f = await fixture(smtp.config, 2, status);
    try { assert.equal(resultValue(await f.recovery.inspect(f.request)).kind, status === "definitiveUnsent" ? status : "unknown");
      assert.equal(resultValue(await f.journal.claim(f.request.requestRef)).send, false); assert.equal(smtp.commands.length, 0);
    } finally { await f.f.close(); }
  });
});

test("E2E-379 scope/account factory substitution, missing import authority and request-supplied origins cannot inspect a receipt", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await fixture(smtp.config, 2);
    try {
      for (const fault of ["scope", "account"]) { f.fault(fault); assert.equal((await f.recovery.inspect(f.request)).ok, false); }
      assert.equal(f.reads, 0); f.fault("");
      assert.throws(() => new ClinikoConfirmationResendRecovery({ ...f.config, importHistory: new PostgresConfirmationResendImportHistory(db, f.origin) }), /invalid resend recovery/);
      const { readerForOrigin: _missingFactory, ...noFactory } = f.config;
      assert.throws(() => new ClinikoConfirmationResendRecovery(noFactory), /invalid resend recovery/);
      const { importHistory: _history, readerForOrigin: _factory, ...unmapped } = f.config;
      assert.equal((await new ClinikoConfirmationResendRecovery(unmapped).inspect(f.request)).ok, false);
      const forgedOrigin = { ...f.request, originScope: f.origin }, forgedBinding = { ...f.request, ownerBinding: binding };
      assert.equal((await f.recovery.inspect(forgedOrigin)).ok, false);
      assert.equal((await f.recovery.inspect(forgedBinding)).ok, false);
      f.permit(false); assert.equal((await f.recovery.inspect(f.request)).ok, false);
      assert.equal(smtp.commands.length, 0);
    } finally { await f.f.close(); }
  });
});

test("E2E-379 changed import receipt, record digest, barrier identity or permission denies lookup without mutation", async () => {
  for (const fault of ["receipt", "history", "barrier", "missing", "duringRead", "permission", "source"]) await withSmtpVerificationServer(async smtp => {
    const f = await fixture(smtp.config, 2, "pending");
    try {
      const change = async () => { await sql`update tenant_config_imports set source_history = jsonb_set(source_history,
        '{locations,0,confirmationResends,0,ownerBinding}', ${JSON.stringify("c".repeat(64))}::jsonb) where target_tenant_id = ${f.f.scope.tenantId}`.execute(db); };
      if (fault === "receipt") await sql`update tenant_config_imports set manifest_digest = ${"c".repeat(64)} where target_tenant_id = ${f.f.scope.tenantId}`.execute(db);
      if (fault === "history") await change();
      if (fault === "barrier") await sql`update confirmation_resend_journal set owner_binding = ${"c".repeat(64)} where tenant_id = ${f.f.scope.tenantId}`.execute(db);
      if (fault === "missing") await sql`delete from confirmation_resend_journal where tenant_id = ${f.f.scope.tenantId}`.execute(db);
      if (fault === "duringRead") f.onRead(change);
      if (fault === "permission") f.onRead(async () => { f.permit(false); });
      if (fault === "source") await f.f.replace({ enabled: false });
      assert.equal((await f.recovery.inspect(f.request)).ok, false);
      if (["receipt", "history", "barrier", "missing", "source"].includes(fault)) assert.equal(f.reads, 0);
      assert.equal(smtp.commands.length, 0); assert.equal(f.f.recalls.length, 0);
    } finally { await f.f.close(); }
  });
});

test("E2E-379 later export refuses to drop known imported barriers or manufacture new origins from changed history", async () => {
  for (const fault of ["history", "missing", "binding", "createdAt"]) await withSmtpVerificationServer(async smtp => {
    const f = await fixture(smtp.config, 2);
    try {
      if (fault === "history") await sql`update tenant_config_imports set source_history = jsonb_set(source_history,
        '{locations,0,confirmationResends,0,originScope,tenantId}', '"foreign"'::jsonb) where target_tenant_id = ${f.f.scope.tenantId}`.execute(db);
      if (fault === "missing") await sql`delete from confirmation_resend_journal where tenant_id = ${f.f.scope.tenantId}`.execute(db);
      if (fault === "binding") await sql`update confirmation_resend_journal set owner_binding = ${"c".repeat(64)} where tenant_id = ${f.f.scope.tenantId}`.execute(db);
      if (fault === "createdAt") await sql`update confirmation_resend_journal set created_at = '2026-01-01T00:00:00Z' where tenant_id = ${f.f.scope.tenantId}`.execute(db);
      const target = { ...f.f.scope, tenantId: `next-resend-${randomUUID()}` };
      assert.deepEqual(await buildPostgresTenantConfigArchive(db, { sourceTenantId: f.f.scope.tenantId, archiveId: randomUUID(), actorRef: "synthetic-owner",
        createdAt: "2026-10-14T05:00:00.000Z", locations: [{ sourceScope: f.f.scope, targetScope: target, timeZone: "Australia/Sydney", mappingProvenance: "reviewed" }] }, exporter),
        { ok: false, error: { kind: "storageCorrupt" } });
    } finally { await f.f.close(); }
  });
});


test("E2E-379 new target resend activity retains its own origin without preventing inspection of transferred receipts", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await fixture(smtp.config, 2);
    try {
      const newRef = randomUUID(), currentBinding = f.f.config.policy.bindingFingerprint();
      resultValue(await new PostgresConfirmationResendJournal(db, f.f.scope, currentBinding).claim(newRef));
      assert.equal(resultValue(await f.importHistory.lookup(newRef, new AbortController().signal)), null);
      assert.equal(resultValue(await f.recovery.inspect(f.request)).kind, "acceptedByMailService");
      const target = { ...f.f.scope, tenantId: `next-active-resend-${randomUUID()}` };
      const archive = resultValue(await buildPostgresTenantConfigArchive(db, { sourceTenantId: f.f.scope.tenantId, archiveId: randomUUID(), actorRef: "synthetic-owner",
        createdAt: "2026-10-14T05:00:00.000Z", locations: [{ sourceScope: f.f.scope, targetScope: target, timeZone: "Australia/Sydney", mappingProvenance: "reviewed" }] }, exporter));
      const data = resultValue(await decodeTenantConfigArchive(archive, target.tenantId)), rows = data.locations[0]!.confirmationResends!;
      assert.deepEqual(rows.find(row => row.requestRef === f.request.requestRef)?.originScope, f.origin);
      assert.equal(rows.find(row => row.requestRef === newRef)?.originScope, undefined);
      assert.equal(rows.length, 2); assert.equal(smtp.commands.length, 0);
    } finally { await f.f.close(); }
  });
});

test("E2E-379 authenticated target staff HTTP lookup observes a transferred receipt with no source-scope request fields", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await fixture(smtp.config, 3);
    const identity = { publicOrigin: "http://127.0.0.1:0", resolveActor: () => f.f.account.actor,
      gatewayFor: (actor: HostActor) => new CommandGateway(actor, f.f.policies, new TextReception(f.f.ledger, f.f.policies, new DisabledStandaloneHost())),
      confirmationResendRecoveryFor: () => f.recovery };
    const server = await createHostAuthenticatedDashboardServer(identity, resolve("dist/dashboard/app.js"));
    try {
      server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`, endpoint = `${origin}/api/confirmation-resends/receipt`;
      const post = (body: unknown) => fetch(endpoint, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const response = await post(f.request); assert.equal(response.status, 200);
      const result = await response.json(); assert.equal(result.value.kind, "acceptedByMailService");
      assert.deepEqual(Object.keys(result.value).sort(), ["kind", "message", "reviewAcknowledged"]);
      for (const canary of [...verificationCanaries, f.origin.tenantId, f.origin.locationId]) assert.equal(JSON.stringify(result).includes(canary), false);
      assert.equal((await post({ ...f.request, originScope: f.origin })).status, 400);
      assert.equal(smtp.commands.length, 0); assert.equal(f.f.recalls.length, 0);
    } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await f.f.close(); }
  });
});
