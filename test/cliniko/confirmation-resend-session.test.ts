import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql } from "kysely";
import { createDisposablePostgres } from "../support/disposable-postgres.ts";
import { ClinikoConfirmationResendSession } from "../../src/standalone/cliniko-confirmation-resend-session.ts";
import { decodeClinikoReview, encodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";
import { confirmationResendFixture } from "../support/confirmation-resend.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

const database = await createDisposablePostgres();
const { db } = database;
after(async () => { await database.close(); });
const signal = () => new AbortController().signal;
function messageBody(message: string): string {
  const text = message.slice(message.indexOf("\r\n\r\n") + 4);
  return message.includes("Content-Transfer-Encoding: base64\r\n") ? Buffer.from(text.replace(/\r\n/g, ""), "base64").toString("utf8") : text;
}

test("E2E-372 private readback and separate confirmation precede linked native review and one correlated SMTP submission", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config);
    try {
      await f.verify(); const prepared = resultValue(await f.session.prepare("81"));
      assert.deepEqual(Object.keys(prepared), ["requestRef"]);
      assert.equal(smtp.commands.length, 0); assert.equal(f.recalls.length, 0);
      assert.equal(f.readbacks.length, 1); assert.match(f.readbacks[0]!, /Séamus Example/);
      assert.match(f.readbacks[0]!, /15:00 \(Australia\/Sydney\)/);
      assert.ok(f.readbacks[0]!.includes(verificationCanaries[0]!));
      f.afterReview(async () => { assert.equal(smtp.commands.length, 0, "no SMTP command precedes native review acknowledgement"); });
      f.confirm(prepared.requestRef);
      const outcome = await f.session.dispatch(prepared.requestRef, signal());
      assert.deepEqual(outcome, { kind: "accepted", messageRef: prepared.requestRef });
      assert.equal(smtp.messages.length, 1); assert.equal(f.recalls.length, 1);
      assert.match(smtp.messages[0]!, new RegExp(`Message-ID: <${prepared.requestRef}@example.test>`));
      assert.match(messageBody(smtp.messages[0]!), /Practitioner: Séamus Example/);
      const review = resultValue(decodeClinikoReview(f.recalls[0]!.notes));
      assert.equal(review.request.operation.kind, "confirmationResend");
      if (review.request.operation.kind !== "confirmationResend") throw new Error("wrong native operation");
      assert.equal(review.request.operation.resendRef, prepared.requestRef); assert.equal(review.request.operation.appointmentId, "81");
      assert.equal(String(f.recalls[0]!.notes).includes(verificationCanaries[0]!), false);
      assert.equal(encodeClinikoReview(review.marker, { ...review.request, operation: { ...review.request.operation, resendRef: "bad-ref" } }).ok, false);
      assert.equal(decodeClinikoReview(String(f.recalls[0]!.notes).replace("Abby confirmation resend review v1", "Abby appointment review v2")).ok, false);
      assert.deepEqual(await f.session.dispatch(prepared.requestRef, signal()), { kind: "denied" });
      assert.equal(smtp.messages.length, 1); assert.equal(f.recalls.length, 1);
      const rows = await sql<Record<string, unknown>>`select * from confirmation_resend_journal where tenant_id = ${f.scope.tenantId}`.execute(db);
      for (const canary of [...verificationCanaries, f.mail[0]!.code, "20 Fixture Road"]) assert.equal(JSON.stringify([rows.rows, prepared, outcome]).includes(canary), false);
      assert.equal(f.traffic.some(v => v.startsWith("PATCH ")), false);
    } finally { await f.close(); }
  });
});

test("E2E-372 channel verification and completed readback do not supply resend consent", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config);
    try {
      await f.verify(); const prepared = resultValue(await f.session.prepare("81"));
      assert.deepEqual(await f.session.dispatch(prepared.requestRef, signal()), { kind: "denied" });
      assert.equal(smtp.commands.length, 0); assert.equal(f.recalls.length, 0); assert.equal(resultValue(await f.journal.read(prepared.requestRef)), null);
    } finally { await f.close(); }
  });
});

test("E2E-372 failed private playback, post-readback target drift and source withdrawal cannot prepare send authority", async () => {
  for (const fault of ["play", "drift", "withdraw"] as const) {
    await withSmtpVerificationServer(async smtp => {
      const f = await confirmationResendFixture(db, smtp.config);
      try {
        await f.verify();
        if (fault === "play") f.setPlay(false);
        if (fault === "drift") f.afterReadback(async () => { f.setAppointment({ starts_at: "2026-10-08T05:00:00.000Z", ends_at: "2026-10-08T05:30:00.000Z" }); });
        if (fault === "withdraw") f.afterReadback(() => f.replace({ enabled: false }));
        assert.equal((await f.session.prepare("81")).ok, false);
        assert.equal(smtp.commands.length, 0); assert.equal(f.recalls.length, 0);
      } finally { await f.close(); }
    });
  }
});

test("E2E-372 wrong patient/business links, cancelled appointments, hostile labels and zone drift are refused before disclosure", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config);
    try {
      await f.verify();
      for (const patch of [{ patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/999" } } },
        { business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/12" } } }, { cancelled_at: "2026-10-04T06:00:00.000Z" }]) {
        f.setAppointment(patch); assert.equal((await f.session.prepare("81")).ok, false);
      }
      f.setAppointment({});
      for (const patch of [{ business_name: "Wrong\r\nBcc: attacker@example.test" }, { time_zone_identifier: "Europe/London" }]) {
        f.setBusiness(patch); assert.equal((await f.session.prepare("81")).ok, false);
      }
      assert.equal(f.readbacks.length, 0); assert.equal(smtp.commands.length, 0); assert.equal(f.recalls.length, 0);
    } finally { await f.close(); }
  });
});

test("E2E-372 a read-only grant cannot perform protected resend selection", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config, "appointments.read");
    try {
      await f.verify(); assert.equal((await f.session.prepare("81")).ok, false);
      assert.equal(f.traffic.some(v => v.includes("individual_appointments")), false);
      assert.equal(f.readbacks.length, 0); assert.equal(smtp.commands.length, 0);
    } finally { await f.close(); }
  });
});

test("E2E-372 uncertain native review or permission loss after review stops before SMTP and is not replayed", async () => {
  for (const fault of ["review", "permission"] as const) {
    await withSmtpVerificationServer(async smtp => {
      const f = await confirmationResendFixture(db, smtp.config);
      try {
        await f.verify(); const prepared = resultValue(await f.session.prepare("81")); f.confirm(prepared.requestRef);
        if (fault === "review") f.setReviewUnknown(); else f.afterReview(async () => { f.setPermitted(false); });
        assert.deepEqual(await f.session.dispatch(prepared.requestRef, signal()), { kind: "denied" });
        assert.equal(f.recalls.length, 1); assert.equal(smtp.commands.length, 0);
        assert.deepEqual(await f.session.dispatch(prepared.requestRef, signal()), { kind: "denied" }); assert.equal(f.recalls.length, 1);
      } finally { await f.close(); }
    });
  }
});

test("E2E-372 permission withdrawal while the durable claim commits is rechecked before SMTP", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config);
    try {
      await f.verify(); const prepared = resultValue(await f.session.prepare("81")); f.confirm(prepared.requestRef);
      const claim = f.journal.claim.bind(f.journal);
      f.journal.claim = async ref => { const result = await claim(ref); f.setPermitted(false); return result; };
      assert.deepEqual(await f.session.dispatch(prepared.requestRef, signal()), { kind: "definitiveUnsent" });
      assert.equal(f.recalls.length, 1); assert.equal(smtp.commands.length, 0);
      assert.deepEqual(resultValue(await f.journal.read(prepared.requestRef)), { kind: "definitiveUnsent" });
    } finally { await f.close(); }
  });
});

test("E2E-372 lost email acceptance retains a correlated native review and durable unknown without replay", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config);
    try {
      await f.verify(); const prepared = resultValue(await f.session.prepare("81")); f.confirm(prepared.requestRef); smtp.fault("dropAfterData");
      assert.deepEqual(await f.session.dispatch(prepared.requestRef, signal()), { kind: "unknown" });
      assert.equal(f.recalls.length, 1); assert.equal(smtp.messages.length, 1);
      assert.match(smtp.messages[0]!, new RegExp(`Message-ID: <${prepared.requestRef}@example.test>`));
      assert.deepEqual(resultValue(await f.journal.read(prepared.requestRef)), { kind: "unknown" });
      assert.deepEqual(await f.session.dispatch(prepared.requestRef, signal()), { kind: "denied" }); assert.equal(smtp.messages.length, 1);
    } finally { await f.close(); }
  });
});

test("E2E-372 owner construction rejects foreign source/journal/sender and mismatched admission", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config);
    try {
      assert.equal((await ClinikoConfirmationResendSession.create({ ...f.config, sessionId: "foreign" })).ok, false);
      assert.equal((await ClinikoConfirmationResendSession.create({ ...f.config, cliniko: { ...f.config.cliniko, apiKey: "foreign-au5" } })).ok, false);
      f.lifetime.abort(); assert.equal((await ClinikoConfirmationResendSession.create(f.config)).ok, false);
    } finally { await f.close(); }
  });
});
