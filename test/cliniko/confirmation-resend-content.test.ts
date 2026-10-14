import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { ClinikoConfirmationEvidenceReader } from "../../src/standalone/cliniko-confirmation-evidence.ts";
import { ClinikoConfirmationResendSession } from "../../src/standalone/cliniko-confirmation-resend-session.ts";
import { SmtpAppointmentConfirmationDelivery } from "../../src/standalone/smtp-appointment-confirmation-delivery.ts";
import { decodeClinikoReview, encodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import { confirmationResendFixture } from "../support/confirmation-resend.ts";
import { resendWorkflow } from "../support/confirmation-resend-workflow.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";

const db = connectPostgres(process.env.DATABASE_URL!); after(async () => { await db.destroy(); });
const content = { template: "appointmentDetails.v2" as const, contentKinds: ["activeInPerson", "activeTelehealth", "cancelled"] as const };
const link = "https://synthetic-clinic.cliniko.com/c/private-patient-join";
const cancelledAt = "2026-10-02T06:00:00.000Z";
const signal = () => new AbortController().signal;
function body(message: string) { return Buffer.from(message.slice(message.indexOf("\r\n\r\n") + 4).replace(/\r\n/g, ""), "base64").toString("utf8"); }
type Fixture = Awaited<ReturnType<typeof confirmationResendFixture>>;
function kind(f: Fixture, variant: typeof content.contentKinds[number]) {
  if (variant === "activeTelehealth") {
    f.setType({ telehealth_enabled: true });
    f.setAppointment({ telehealth_url: "https://synthetic-clinic.cliniko.com/appointments/81/connect" });
    f.setBusiness({ address_1: null }); // A physical address is irrelevant to an online visit.
  }
  if (variant === "cancelled") f.setChoices([{ id: "81", starts_at: "2026-10-03T04:00:00.000Z", ends_at: "2026-10-03T04:30:00.000Z", cancelled_at: cancelledAt }]);
}

for (const variant of content.contentKinds) test(`E2E-380 current ${variant} details require played separate SAM consent and one reviewed encrypted send`, async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", true, undefined, undefined, content);
    let w: Awaited<ReturnType<typeof resendWorkflow>> | undefined;
    try {
      kind(f, variant); w = await resendWorkflow(f); await w.verify();
      assert.deepEqual(resultValue(await w.flow.listResendAppointments()), { count: 1, hasNext: false, hasPrevious: false });
      if (variant === "cancelled") assert.match(f.readbacks[0]!, /3 October.*cancelled/);
      const prepared = resultValue(await w.flow.selectResendAppointment(1));
      assert.equal(smtp.messages.length, 0); assert.equal(f.recalls.length, 0);
      const now = f.sessionConfig.clock();
      resultValue(await w.reception.proposeConfirmationResend(f.scope, w.turn("propose", "Send my appointment email"), prepared.requestRef, now));
      const action = Object.values((await f.state()).actions).find(a => a.kind === "confirmationResend")!;
      resultValue(await f.runtime.startPresentation(f.callId, action.presentationId, f.sessionId, now));
      resultValue(await f.runtime.resolvePresentation(f.callId, action.presentationId, "played", f.sessionId, now));
      resultValue(await f.runtime.acceptTurn(w.turn("yes", "Yes"), { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }, now));
      await new EffectWorker(f.runtime, w.flow).process(f.callId, `${action.key}:write`, now);
      assert.equal((await f.state()).actions[action.key]!.status, "committed");
      assert.equal(smtp.messages.length, 1); assert.equal(f.recalls.length, 1);
      const text = body(smtp.messages[0]!);
      if (variant === "activeInPerson") assert.match(text, /Address: 20 Fixture Road/);
      if (variant === "activeTelehealth") { assert.ok(text.includes(link)); assert.doesNotMatch(text, /Address:|\/connect|Cancelled/); }
      if (variant === "cancelled") { assert.match(text, /Status: Cancelled\. This appointment is no longer booked/); assert.doesNotMatch(text, /Address:|Patient join link:|refund|attend online/i); }
      const native = resultValue(decodeClinikoReview(f.recalls[0]!.notes));
      assert.equal(native.request.operation.kind, "confirmationResend");
      if (native.request.operation.kind !== "confirmationResend") throw new Error("wrong operation");
      assert.equal(native.request.operation.contentKind, variant);
      assert.equal(native.request.patientId, verificationCanaries[2], "patient binding belongs in the approved native review");
      assert.equal(encodeClinikoReview(native.marker, { ...native.request, operation: { ...native.request.operation, contentKind: [variant] } } as unknown as typeof native.request).ok, false);
      assert.equal(decodeClinikoReview(String(f.recalls[0]!.notes).replace("review v2", "review v1")).ok, false);
      assert.equal(encodeClinikoReview(native.marker, { ...native.request, operation: { ...native.request.operation, patientJoinUrl: link } } as typeof native.request).ok, false);
      const rows = await sql<Record<string, unknown>>`select * from confirmation_resend_journal where tenant_id = ${f.scope.tenantId}`.execute(db);
      for (const secret of [...verificationCanaries, f.mail[0]!.code, link, "20 Fixture Road"]) {
        assert.equal(JSON.stringify([await f.state(), rows.rows, prepared]).includes(secret), false);
        if (secret !== verificationCanaries[2]) assert.equal(JSON.stringify(f.recalls).includes(secret), false);
      }
      assert.equal(f.traffic.some(v => /^(PATCH|DELETE) /.test(v)), false);
      assert.equal((await w.flow.selectResendAppointment(1)).ok, false);
    } finally { w?.flow.dispose(); await f.close(); }
  });
});

test("E2E-380 legacy consent and unapproved content cannot enable telehealth or cancelled emails", async () => {
  for (const variant of ["activeTelehealth", "cancelled"] as const) await withSmtpVerificationServer(async smtp => {
    for (const approved of [undefined, { template: "appointmentDetails.v2" as const, contentKinds: ["activeInPerson"] as const }]) {
      const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", false, undefined, undefined, approved);
      try {
        await f.verify(); kind(f, variant);
        assert.equal((await f.session.prepare("81")).ok, false);
        assert.equal(f.readbacks.length, 0); assert.equal(smtp.commands.length, 0); assert.equal(f.recalls.length, 0);
      } finally { await f.close(); }
    }
  });
});

test("E2E-380 telehealth uses exactly one current patient attendee and refuses staff links, misbindings and incomplete native data", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", false, undefined, undefined, content);
    try {
      await f.verify(); kind(f, "activeTelehealth");
      const reader = new ClinikoConfirmationEvidenceReader(f.config);
      assert.ok(await reader.read("81", signal()));
      for (const patch of [{ patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/99" } } },
        { booking: { links: { self: "https://api.au5.cliniko.com/v1/bookings/99" } } },
        { cancelled_at: cancelledAt }, { deleted_at: cancelledAt }, { archived_at: cancelledAt }, { id: "bad" },
        ...["https://synthetic-clinic.cliniko.com/appointments/81/connect", "https://attacker.example/c/private", "http://synthetic-clinic.cliniko.com/c/private",
          "https://different-clinic.cliniko.com/c/private-patient-join", `${link}?redirect=elsewhere`, "https://user@synthetic-clinic.cliniko.com/c/private", `${link}\r\nBcc: attacker@example.test`].map(telehealth_url => ({ telehealth_url }))]) {
        f.setAttendee(patch); assert.equal(await reader.read("81", signal()), undefined);
      }
      f.setAttendee({});
      for (const telehealth_enabled of [undefined, "true", 1]) {
        f.setType({ telehealth_enabled }); assert.equal(await reader.read("81", signal()), undefined);
      }
      f.setType({ telehealth_enabled: true });
      for (const fault of ["duplicate", "missing", "totalDrift", "emptyPage", "tooMany", "unavailable"] as const) {
        let pages = 0;
        const reader = new ClinikoConfirmationEvidenceReader({ ...f.config, fetchPort: async (url, init) => {
          const response = await f.config.fetchPort(url, init);
          if (new URL(String(url)).pathname !== "/v1/attendees") return response;
          const data = await response.json(); pages++;
          if (fault === "unavailable") return new Response(null, { status: 503 });
          if (fault === "duplicate") data.attendees.push(data.attendees[0]);
          if (fault === "missing") { data.attendees = []; data.total_entries = 0; }
          if (fault === "totalDrift") data.total_entries = pages === 1 ? 2 : 3;
          if (fault === "emptyPage") { data.total_entries = 2; if (pages === 2) data.attendees = []; }
          if (fault === "tooMany") data.total_entries = 501;
          return Response.json(data);
        } });
        assert.equal(await reader.read("81", signal()), undefined, fault);
      }
      assert.equal(f.readbacks.length, 0); assert.equal(smtp.messages.length, 0); assert.equal(f.recalls.length, 0);
    } finally { await f.close(); }
  });
});

test("E2E-380 status, patient link, recipient and attendance drift at readback, review or claim withdraw the exact content", async () => {
  for (const phase of ["readback", "review", "claim"] as const) for (const fault of ["link", "mode", "status", "recipient", "permission"] as const) {
    await withSmtpVerificationServer(async smtp => {
      const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", false, undefined, undefined, content);
      try {
        await f.verify(); kind(f, "activeTelehealth");
        const drift = async () => {
          if (fault === "link") f.setAttendee({ telehealth_url: "https://synthetic-clinic.cliniko.com/c/changed-patient-join" });
          if (fault === "mode") f.setType({ telehealth_enabled: false });
          if (fault === "status") f.setAppointment({ cancelled_at: cancelledAt });
          if (fault === "recipient") f.setEmail("changed@example.test");
          if (fault === "permission") f.setPermitted(false);
        };
        if (phase === "readback") f.afterReadback(drift);
        const prepared = await f.session.prepare("81");
        if (phase === "readback") assert.equal(prepared.ok, false);
        else {
          const ref = resultValue(prepared).requestRef; f.confirm(ref);
          if (phase === "review") f.afterReview(drift);
          else { const claim = f.journal.claim.bind(f.journal); f.journal.claim = async ref => { const claimed = await claim(ref); await drift(); return claimed; }; }
          assert.deepEqual(await f.session.dispatch(ref, signal()), { kind: phase === "claim" ? "definitiveUnsent" : "denied" });
          assert.deepEqual(await f.session.dispatch(ref, signal()), { kind: "denied" });
        }
        assert.equal(smtp.commands.length, 0);
        assert.equal(f.recalls.length, phase === "readback" ? 0 : 1);
      } finally { await f.close(); }
    });
  }
});

test("E2E-380 cancelled history is selected privately, while restored or changed cancellations withdraw it", async () => {
  for (const fault of ["restored", "changed", "archived", "futureCancellation", "old"] as const) await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", false, undefined, undefined, content);
    try {
      await f.verify(); kind(f, "cancelled");
      if (fault === "futureCancellation") f.setAppointment({ cancelled_at: "2026-10-10T06:00:00.000Z" });
      if (fault === "old") f.setAppointment({ starts_at: "2026-01-03T04:00:00.000Z", ends_at: "2026-01-03T04:30:00.000Z" });
      const prepared = await f.session.prepare("81");
      if (fault === "futureCancellation" || fault === "old") assert.equal(prepared.ok, false);
      else {
        const ref = resultValue(prepared).requestRef; f.confirm(ref);
        f.setAppointment(fault === "restored" ? { cancelled_at: null } : fault === "archived" ? { archived_at: cancelledAt } : { cancelled_at: "2026-10-02T07:00:00.000Z" });
        assert.deepEqual(await f.session.dispatch(ref, signal()), { kind: "denied" });
      }
      assert.equal(smtp.commands.length, 0); assert.equal(f.recalls.length, 0);
    } finally { await f.close(); }
  });
});

test("E2E-380 mismatched adapter template cannot construct an approved resend owner", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", false, undefined, undefined, content);
    try { assert.equal((await ClinikoConfirmationResendSession.create({ ...f.config, email: new SmtpAppointmentConfirmationDelivery(smtp.config) })).ok, false); }
    finally { await f.close(); }
  });
});

test("E2E-380 cancelled-only menus remain selectable after a forty-second conversation with renewed call authority", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(db, smtp.config, "appointments.resend", true, undefined, undefined,
      { template: "appointmentDetails.v2", contentKinds: ["cancelled"] });
    let w: Awaited<ReturnType<typeof resendWorkflow>> | undefined;
    try {
      f.setChoices([{ id: "81", starts_at: "2026-10-03T04:00:00.000Z", ends_at: "2026-10-03T04:30:00.000Z", cancelled_at: cancelledAt },
        { id: "82", starts_at: "2026-10-09T04:00:00.000Z", ends_at: "2026-10-09T04:30:00.000Z" }]);
      w = await resendWorkflow(f); await w.verify();
      assert.deepEqual(resultValue(await w.flow.listResendAppointments()), { count: 1, hasNext: false, hasPrevious: false });
      for (const seconds of [20, 40]) {
        f.setTime(`2026-10-04T06:00:${seconds}.000Z`);
        const lease = (await f.state()).sessionLease!;
        resultValue(await f.runtime.renewSession(f.callId, f.sessionId, lease.version, f.sessionConfig.clock()));
      }
      const prepared = resultValue(await w.flow.selectResendAppointment(1));
      assert.ok(prepared.requestRef); assert.match(f.readbacks.at(-1)!, /Status: Cancelled/);
      assert.equal(f.recalls.length, 0); assert.equal(smtp.commands.length, 0);
    } finally { w?.flow.dispose(); await f.close(); }
  });
});
