import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresConfirmationResendJournal } from "../../src/storage/postgres-confirmation-resend-journal.ts";
import { DurableConfirmationSubmission } from "../../src/standalone/durable-confirmation-submission.ts";
import { SmtpAppointmentConfirmationDelivery } from "../../src/standalone/smtp-appointment-confirmation-delivery.ts";
import type { AppointmentConfirmationMail } from "../../src/standalone/smtp-appointment-confirmation-delivery.ts";
import { down, up } from "../../src/storage/migrations/047_confirmation_resend_journal.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });
const scope = () => ({ tenantId: `resend-${randomUUID()}`, clinicId: "clinic", locationId: "location" });
const binding = "a".repeat(64);
const appointment: AppointmentConfirmationMail = { email: "private-recipient@example.test", startsAt: "2026-10-13T12:30:00.000Z", endsAt: "2026-10-13T13:00:00.000Z",
  timeZone: "Europe/London", clinicName: "Synthetic Clinic", locationName: "Synthetic Branch", locationAddress: "private-address-canary",
  practitionerName: "Synthetic Practitioner", appointmentTypeName: "Follow-up" };

test("E2E-371 racing claims and a fresh store permit exactly one SMTP submission; metadata excludes patient/call/content", async () => {
  const owner = scope(), ref = randomUUID(), journal = new PostgresConfirmationResendJournal(db, owner, binding);
  await withSmtpVerificationServer(async smtp => {
    const delivery = new SmtpAppointmentConfirmationDelivery(smtp.config);
    const a = new DurableConfirmationSubmission(journal, delivery), b = new DurableConfirmationSubmission(new PostgresConfirmationResendJournal(db, owner, binding), delivery);
    const results = await Promise.all([a.submit(ref, appointment, new AbortController().signal), b.submit(ref, appointment, new AbortController().signal)]);
    assert.ok(results.some(r => r.kind === "accepted"));
    assert.ok(results.every(r => r.kind === "accepted" || r.kind === "unknown"));
    assert.equal(smtp.messages.length, 1);
    const restarted = new DurableConfirmationSubmission(new PostgresConfirmationResendJournal(db, owner, binding), delivery);
    assert.equal((await restarted.submit(ref, appointment, new AbortController().signal)).kind, "accepted");
    assert.equal(smtp.messages.length, 1);
    const stored = await sql<Record<string, unknown>>`select * from confirmation_resend_journal where tenant_id = ${owner.tenantId}`.execute(db);
    assert.deepEqual(Object.keys(stored.rows[0]!).sort(), ["clinic_id", "completed_at", "created_at", "location_id", "message_ref", "owner_binding", "request_ref", "status", "tenant_id"]);
    for (const canary of [appointment.email, appointment.locationAddress, "native-patient-id", "private-call-id"]) assert.equal(JSON.stringify(stored.rows).includes(canary), false);
    assert.deepEqual(resultValue(await journal.claim(ref)), { send: false, status: resultValue(await journal.read(ref)) });
  });
});

test("E2E-371 lost SMTP acceptance persists unknown and cannot be resent after restart or new binding", async () => {
  const owner = scope(), ref = randomUUID(), journal = new PostgresConfirmationResendJournal(db, owner, binding);
  await withSmtpVerificationServer(async smtp => {
    smtp.fault("dropAfterData"); const delivery = new SmtpAppointmentConfirmationDelivery(smtp.config);
    assert.deepEqual(await new DurableConfirmationSubmission(journal, delivery).submit(ref, appointment, new AbortController().signal), { kind: "unknown" });
    smtp.fault(undefined);
    assert.deepEqual(await new DurableConfirmationSubmission(new PostgresConfirmationResendJournal(db, owner, binding), delivery)
      .submit(ref, appointment, new AbortController().signal), { kind: "unknown" });
    assert.equal(smtp.messages.length, 1);
    assert.deepEqual(await new PostgresConfirmationResendJournal(db, owner, "b".repeat(64)).claim(ref), { ok: false, error: { kind: "bindingMismatch" } });
    assert.deepEqual(await journal.finish(ref, { kind: "accepted", messageRef: randomUUID() }), { ok: false, error: { kind: "invalidTransition" } });
  });
});

test("E2E-371 a process-lost claim is uncertain without SMTP replay, and scopes cannot reuse another owner's reference", async () => {
  const owner = scope(), ref = randomUUID(), journal = new PostgresConfirmationResendJournal(db, owner, binding);
  assert.equal(resultValue(await journal.claim(ref)).send, true);
  await withSmtpVerificationServer(async smtp => {
    const restarted = new DurableConfirmationSubmission(new PostgresConfirmationResendJournal(db, owner, binding), new SmtpAppointmentConfirmationDelivery(smtp.config));
    assert.deepEqual(await restarted.submit(ref, appointment, new AbortController().signal), { kind: "unknown" });
    assert.equal(smtp.commands.length, 0);
  });
  for (const foreign of [{ ...owner, locationId: "other" }, { ...owner, clinicId: "other" }]) {
    const changed = new PostgresConfirmationResendJournal(db, foreign, binding);
    assert.deepEqual(await changed.read(ref), { ok: false, error: { kind: "bindingMismatch" } });
    assert.deepEqual(await changed.claim(ref), { ok: false, error: { kind: "bindingMismatch" } });
  }
  const otherTenant = new PostgresConfirmationResendJournal(db, { ...owner, tenantId: `${owner.tenantId}-other` }, binding);
  assert.equal(resultValue(await otherTenant.read(ref)), null);
  assert.equal(resultValue(await otherTenant.claim(ref)).send, true);
});

test("E2E-371 definitive rejection, invalid input and abort never provide retry permission", async () => {
  const journal = new PostgresConfirmationResendJournal(db, scope(), binding), ref = randomUUID();
  await withSmtpVerificationServer(async smtp => {
    smtp.fault("recipientRejected");
    const submission = new DurableConfirmationSubmission(journal, new SmtpAppointmentConfirmationDelivery(smtp.config));
    assert.deepEqual(await submission.submit(ref, appointment, new AbortController().signal), { kind: "definitiveUnsent" });
    const count = smtp.commands.length; smtp.fault(undefined);
    assert.deepEqual(await submission.submit(ref, appointment, new AbortController().signal), { kind: "definitiveUnsent" });
    assert.equal(smtp.commands.length, count);
    const stopped = new AbortController(); stopped.abort(); const stoppedRef = randomUUID();
    assert.deepEqual(await submission.submit(stoppedRef, appointment, stopped.signal), { kind: "denied" });
    assert.equal(resultValue(await journal.read(stoppedRef)), null);
    assert.deepEqual(await journal.claim("native-patient-id"), { ok: false, error: { kind: "invalidInput" } });
    assert.deepEqual(await journal.finish(ref, { kind: "accepted", messageRef: "patient@example.test" }), { ok: false, error: { kind: "invalidInput" } });
  });
});

test("E2E-371 transport exceptions or unpersisted acceptance retain uncertainty and never re-enter delivery", async () => {
  const journal = new PostgresConfirmationResendJournal(db, scope(), binding), ref = randomUUID(); let sends = 0;
  const thrown = new DurableConfirmationSubmission(journal, { send: async () => { sends++; throw new Error("lost send"); } });
  assert.deepEqual(await thrown.submit(ref, appointment, new AbortController().signal), { kind: "unknown" });
  assert.deepEqual(await thrown.submit(ref, appointment, new AbortController().signal), { kind: "unknown" });
  assert.equal(sends, 1);
  const lostRef = randomUUID(), lost = new DurableConfirmationSubmission({ claim: key => journal.claim(key), read: key => journal.read(key),
    finish: async () => ({ ok: false, error: { kind: "storageFailure" } }) }, { send: async () => { sends++; return { kind: "accepted", messageRef: randomUUID() }; } });
  assert.deepEqual(await lost.submit(lostRef, appointment, new AbortController().signal), { kind: "unknown" });
  assert.deepEqual(resultValue(await journal.read(lostRef)), { kind: "possiblySent" });
  assert.deepEqual(await thrown.submit(lostRef, appointment, new AbortController().signal), { kind: "unknown" });
  assert.equal(sends, 2);
});

test("E2E-371 malformed claim results cannot cross the SMTP barrier", async () => {
  const journal = new PostgresConfirmationResendJournal(db, scope(), binding); let sends = 0, finishes = 0;
  for (const response of [undefined, { ok: true, value: { send: "yes", status: { kind: "possiblySent" } } },
    { ok: true, value: { send: true, status: { kind: "accepted", messageRef: randomUUID() } } },
    { ok: true, value: { send: true, status: { kind: "possiblySent", recipient: appointment.email } } }]) {
    const submission = new DurableConfirmationSubmission({ claim: async () => response as never, read: ref => journal.read(ref),
      finish: async () => { finishes++; return { ok: true, value: true }; } }, { send: async () => { sends++; return { kind: "unknown" }; } });
    assert.deepEqual(await submission.submit(randomUUID(), appointment, new AbortController().signal), { kind: "denied" });
  }
  assert.equal(sends, 0); assert.equal(finishes, 0);
});

test("E2E-371 tenant freezes guard claims and completions; retained history cannot be rolled back or truncated", async () => {
  const owner = scope(), ref = randomUUID(), journal = new PostgresConfirmationResendJournal(db, owner, binding);
  resultValue(await journal.claim(ref));
  await sql`update tenant_portability_fences set frozen = true where tenant_id = ${owner.tenantId}`.execute(db);
  assert.deepEqual(await journal.claim(randomUUID()), { ok: false, error: { kind: "storageFailure" } });
  assert.deepEqual(await journal.finish(ref, { kind: "unknown" }), { ok: false, error: { kind: "storageFailure" } });
  assert.deepEqual(resultValue(await journal.read(ref)), { kind: "possiblySent" });
  await assert.rejects(sql`truncate confirmation_resend_journal`.execute(db), /truncate bypasses tenant portability fences/);
  await assert.rejects(down(db), /history\/fence must be retained/);
  await sql`update tenant_portability_fences set frozen = false where tenant_id = ${owner.tenantId}`.execute(db);
  resultValue(await journal.finish(ref, { kind: "unknown" }));
  resultValue(await journal.finish(ref, { kind: "unknown" }));
  await assert.rejects(down(db), /history\/fence must be retained/);
});

test("E2E-371 empty migration downgrade and re-upgrade preserve installation without deleting history", async () => {
  await withDisposablePostgres(async isolated => {
    await down(isolated); await up(isolated);
    assert.equal(resultValue(await new PostgresConfirmationResendJournal(isolated, scope(), binding).claim(randomUUID())).send, true);
    await assert.rejects(down(isolated), /history\/fence must be retained/);
  });
});
