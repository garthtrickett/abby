import assert from "node:assert/strict";
import { after, test } from "node:test";
import { once } from "node:events";
import { resolve } from "node:path";
import { createDisposablePostgres } from "../support/disposable-postgres.ts";
import { PostgresConfirmationResendJournal } from "../../src/storage/postgres-confirmation-resend-journal.ts";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { encodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { ClinikoConfirmationResendRecovery } from "../../src/standalone/cliniko-confirmation-resend-recovery.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { createHostAuthenticatedDashboardServer } from "../../src/standalone/dashboard/server.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import type { HostActor } from "../../src/reference/command-gateway.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { DisabledStandaloneHost } from "../../src/standalone/disabled-host.ts";
import { DurableConfirmationSubmission } from "../../src/standalone/durable-confirmation-submission.ts";
import { confirmationResendFixture } from "../support/confirmation-resend.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";

const database = await createDisposablePostgres();
const { db } = database;
after(async () => { await database.close(); });
async function fixture(smtp: Parameters<typeof confirmationResendFixture>[1], historical = false) {
  const f = await confirmationResendFixture(db, smtp, "appointments.resend", true), requestRef = crypto.randomUUID();
  const binding = historical ? "b".repeat(64) : f.config.policy.bindingFingerprint();
  const journal = new PostgresConfirmationResendJournal(db, f.scope, binding);
  const envelope = { scope: f.scope, patientId: verificationCanaries[2]!, businessId: "11", credentialFingerprint: clinikoCredentialFingerprint(f.config.cliniko.apiKey),
    policyVersion: historical ? "older-policy" : f.sessionConfig.policyVersion, termsVersion: binding, timeZone: "Australia/Sydney", createdAt: f.sessionConfig.clock(),
    operation: { kind: "confirmationResend" as const, resendRef: requestRef, appointmentId: "81", practitionerId: "22", appointmentTypeId: "33",
      startsAt: "2026-10-08T04:00:00.000Z", endsAt: "2026-10-08T04:30:00.000Z" } };
  let row = { id: "91", archived_at: null, recalled: false, updated_at: "2026-10-04T06:00:00.000Z",
    notes: resultValue(encodeClinikoReview(crypto.randomUUID(), envelope)), links: { self: "https://api.au5.cliniko.com/v1/recalls/91" },
    patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${verificationCanaries[2]}` } }, recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/7" } } };
  let actor: HostActor | null = f.account.actor, permitted = false, reads = 0, onRead = async () => {};
  const reader = resultValue(ClinikoRecallReader.create({ scope: f.scope, apiKey: f.config.cliniko.apiKey, contactEmail: "test@example.test" }, async (_value, init) => {
    assert.equal(init?.method, "GET"); reads++; const result = Response.json(row); await onRead(); return result;
  }));
  const recovery = new ClinikoConfirmationResendRecovery({ scope: f.scope, businessId: "11", credentialFingerprint: envelope.credentialFingerprint,
    timeZone: "Australia/Sydney", recallTypeId: "7", reader, policy: f.config.policy, directory: new OwnerFileAdminDirectory(f.accountPath, f.scope),
    journalFor: hash => new PostgresConfirmationResendJournal(db, f.scope, hash),
    authority: { currentActor: async () => actor, permitsReceiptInspection: async () => permitted } });
  return { f, journal, recovery, request: { requestRef, recallRef: "cliniko:recall:91" },
    actor: (value: HostActor | null) => { actor = value; }, permit: (value: boolean) => { permitted = value; },
    patch: (value: Partial<typeof row>) => { row = { ...row, ...value }; }, onRead: (run: () => Promise<void>) => { onRead = run; }, get reads() { return reads; } };
}

test("E2E-377 cold resend recovery distinguishes stored receipt states and never treats recall acknowledgement as SMTP acceptance", async () => {
  for (const status of ["missing", "pending", "accepted", "unknown", "definitiveUnsent", "wrongMessage"] as const) {
    await withSmtpVerificationServer(async smtp => {
      const f = await fixture(smtp.config, true);
      try {
        if (status !== "missing") resultValue(await f.journal.claim(f.request.requestRef));
        if (status === "accepted" || status === "wrongMessage") resultValue(await f.journal.finish(f.request.requestRef, { kind: "accepted", messageRef: status === "accepted" ? f.request.requestRef : crypto.randomUUID() }));
        if (status === "unknown" || status === "definitiveUnsent") resultValue(await f.journal.finish(f.request.requestRef, { kind: status }));
        assert.equal((await f.recovery.inspect(f.request)).ok, false); f.permit(true); f.patch({ recalled: true });
        const before = resultValue(await f.journal.read(f.request.requestRef));
        const result = resultValue(await f.recovery.inspect(f.request));
        assert.equal(result.kind, status === "missing" ? "notRecorded" : status === "accepted" ? "acceptedByMailService" : status === "definitiveUnsent" ? status : "unknown");
        assert.equal(result.reviewAcknowledged, true);
        if (status === "accepted") assert.match(result.message, /Inbox delivery has not been verified/);
        assert.deepEqual(resultValue(await f.journal.read(f.request.requestRef)), before);
        for (const secret of verificationCanaries) assert.equal(JSON.stringify(result).includes(secret), false);
        assert.equal(smtp.commands.length, 0); assert.equal(f.f.recalls.length, 0);
      } finally { await f.f.close(); }
    });
  }
});

test("E2E-377 resend recovery rejects actor/record/source drift and request-supplied authority", async () => {
  for (const fault of ["agent", "absent", "foreign", "extra", "record", "permission", "source"] as const) {
    await withSmtpVerificationServer(async smtp => {
      const f = await fixture(smtp.config);
      try {
        f.permit(true); resultValue(await f.journal.claim(f.request.requestRef));
        if (fault === "agent") f.actor({ ...f.f.account.actor, role: "agent" });
        if (fault === "absent") f.actor(null);
        if (fault === "foreign") f.actor({ ...f.f.account.actor, scope: { ...f.f.scope, locationId: "elsewhere" } });
        if (fault === "record") f.onRead(async () => { f.patch({ updated_at: "2026-10-04T06:00:01.000Z" }); });
        if (fault === "permission") f.onRead(async () => { f.permit(false); });
        if (fault === "source") await f.f.replace({ enabled: false });
        const request = fault === "extra" ? { ...f.request, actorRef: f.f.account.actor.actorRef } : f.request;
        assert.equal((await f.recovery.inspect(request)).ok, false);
        assert.deepEqual(resultValue(await f.journal.read(f.request.requestRef)), { kind: "possiblySent" });
        assert.equal(smtp.commands.length, 0);
      } finally { await f.f.close(); }
    });
  }
});

test("E2E-377 a restarted private submitter cannot attribute a different accepted message to this resend", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await fixture(smtp.config);
    try {
      resultValue(await f.journal.claim(f.request.requestRef));
      resultValue(await f.journal.finish(f.request.requestRef, { kind: "accepted", messageRef: crypto.randomUUID() }));
      const submitter = new DurableConfirmationSubmission(f.journal, f.f.config.email);
      const result = await submitter.submit(f.request.requestRef, { email: verificationCanaries[0]!, startsAt: "2026-10-08T04:00:00.000Z",
        endsAt: "2026-10-08T04:30:00.000Z", timeZone: "Australia/Sydney", clinicName: "Synthetic Clinic", locationName: "Synthetic Branch",
        locationAddress: "20 Fixture Road", practitionerName: "Synthetic Practitioner", appointmentTypeName: "Follow up" }, new AbortController().signal);
      assert.deepEqual(result, { kind: "unknown" }); assert.equal(smtp.commands.length, 0);
    } finally { await f.f.close(); }
  });
});

test("E2E-377 authenticated staff resend-receipt HTTP endpoint is scoped, origin-checked and hidden from setup/caller surfaces", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await fixture(smtp.config); let actor: HostActor | null = { ...f.f.account.actor, role: "agent" }, factories = 0;
    const identity = { publicOrigin: "http://127.0.0.1:0", resolveActor: () => actor,
      gatewayFor: (bound: HostActor) => new CommandGateway(bound, f.f.policies, new TextReception(f.f.ledger, f.f.policies, new DisabledStandaloneHost())),
      confirmationResendRecoveryFor: () => { factories++; return f.recovery; } };
    const server = await createHostAuthenticatedDashboardServer(identity, resolve("dist/dashboard/app.js"));
    try {
      server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`, endpoint = `${origin}/api/confirmation-resends/receipt`;
      const post = (body: unknown, suppliedOrigin = origin) => fetch(endpoint, { method: "POST", headers: { Origin: suppliedOrigin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal((await post(f.request)).status, 403); assert.equal(factories, 0); actor = f.f.account.actor;
      assert.equal((await post({ ...f.request, resend: true })).status, 400);
      assert.equal((await post(f.request, "https://foreign.example.test")).status, 403); assert.equal(factories, 0);
      f.permit(true); resultValue(await f.journal.claim(f.request.requestRef));
      const response = await post(f.request); assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.value.kind, "unknown");
      assert.equal(factories, 1); assert.equal(smtp.commands.length, 0);
      const setup = await createHostAuthenticatedDashboardServer({ ...identity, surface: "availabilitySetup" }, resolve("dist/dashboard/app.js"));
      try {
        setup.listen(0, "127.0.0.1"); await once(setup, "listening"); const at = setup.address(); assert.ok(at && typeof at !== "string");
        const root = `http://127.0.0.1:${at.port}`;
        assert.equal((await fetch(`${root}/api/confirmation-resends/receipt`, { method: "POST", headers: { Origin: root, "Content-Type": "application/json" }, body: JSON.stringify(f.request) })).status, 404);
        assert.equal(factories, 1);
      } finally { setup.closeAllConnections(); await new Promise<void>(done => setup.close(() => done())); }
    } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await f.f.close(); }
  });
});
