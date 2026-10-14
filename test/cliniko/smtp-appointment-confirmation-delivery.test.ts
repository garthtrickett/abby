import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SmtpAppointmentConfirmationDelivery } from "../../src/standalone/smtp-appointment-confirmation-delivery.ts";
import type { AppointmentConfirmationMail } from "../../src/standalone/smtp-appointment-confirmation-delivery.ts";
import { SmtpTextMailTransport } from "../../src/standalone/smtp-text-mail-transport.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";

const appointment: AppointmentConfirmationMail = {
  email: "patient@example.test", startsAt: "2026-10-13T12:30:00Z", endsAt: "2026-10-13T13:30:00Z", timeZone: "Europe/London",
  clinicName: "Synthetic Clinic", locationName: "Synthetic Branch", locationAddress: "12 Example Street",
  practitionerName: "Synthetic Practitioner", appointmentTypeName: "Initial assessment",
};
function body(message: string): string {
  const at = message.indexOf("\r\n\r\n"), text = message.slice(at + 4);
  return message.includes("Content-Transfer-Encoding: base64\r\n") ? Buffer.from(text.replace(/\r\n/g, ""), "base64").toString("utf8") : text;
}

describe("E2E-370 private appointment confirmation SMTP adapter", { concurrency: 2 }, () => {
  test("E2E-370 one encrypted submission carries current details in the appointment time zone", async () => {
    await withSmtpVerificationServer(async smtp => {
      const delivery = new SmtpAppointmentConfirmationDelivery(smtp.config);
      const result = await delivery.send(appointment, new AbortController().signal);
      assert.equal(result.kind, "accepted");
      assert.equal(smtp.messages.length, 1);
      assert.equal(smtp.commands.filter(line => line === "DATA").length, 1);
      const message = smtp.messages[0]!;
      assert.match(message, /^To: patient@example.test$/m);
      assert.match(message, /^Subject: Your appointment details$/m);
      assert.equal(body(message), ["Appointment details", "Clinic: Synthetic Clinic", "Location: Synthetic Branch", "Address: 12 Example Street",
        "Date: Tuesday, 13 October 2026", "Time: 13:30 (Europe/London)", "Duration: 60 minutes",
        "Practitioner: Synthetic Practitioner", "Appointment: Initial assessment"].join("\r\n"));
      const publicProjection = JSON.stringify([delivery, result]);
      for (const privateValue of [appointment.email, appointment.locationAddress, appointment.practitionerName, smtp.config.password]) {
        assert.equal(publicProjection.includes(privateValue), false);
      }
      assert.equal(message.includes("Verification code:"), false);
      assert.equal(message.includes("payment"), false);
    });
  });
  test("E2E-370 Unicode details use bounded MIME lines and follow appointment DST rules", async () => {
    await withSmtpVerificationServer(async smtp => {
      const result = await new SmtpAppointmentConfirmationDelivery(smtp.config).send({ ...appointment,
        startsAt: "2026-10-07T00:30:00.000Z", endsAt: "2026-10-07T01:15:00.000Z", timeZone: "Pacific/Auckland",
        practitionerName: "Séamus", locationName: "Whitianga" }, new AbortController().signal);
      assert.equal(result.kind, "accepted"); const message = smtp.messages[0]!;
      assert.match(message, /Content-Transfer-Encoding: base64\r\n/);
      assert.match(body(message), /Time: 13:30 \(Pacific\/Auckland\)/);
      assert.match(body(message), /Duration: 45 minutes/);
      assert.match(body(message), /Practitioner: Séamus/);
      assert.ok(message.split("\r\n").every(line => Buffer.byteLength(line) <= 998));
    });
  });
  for (const fault of ["authRejected", "recipientRejected", "noPlain", "mixedReply", "overlongReply", "dataRejected", "dropAfterData", "unexpectedDataReply"] as const) {
    test(`E2E-370 ${fault} has a truthful result and never retries submission`, async () => {
      await withSmtpVerificationServer(async smtp => {
        smtp.fault(fault);
        const result = await new SmtpAppointmentConfirmationDelivery(smtp.config).send(appointment, new AbortController().signal);
        const afterBody = ["dataRejected", "dropAfterData", "unexpectedDataReply"].includes(fault);
        assert.deepEqual(result, { kind: ["dropAfterData", "unexpectedDataReply"].includes(fault) ? "unknown" : "definitiveUnsent" });
        assert.equal(smtp.messages.length, afterBody ? 1 : 0);
        assert.equal(smtp.commands.filter(line => line === "DATA").length, afterBody ? 1 : 0);
        assert.equal(JSON.stringify(result).includes(appointment.email), false);
      });
    });
  }
  test("E2E-370 invalid details, injection, unknown keys and prior abort stop before SMTP", async () => {
    await withSmtpVerificationServer(async smtp => {
      const delivery = new SmtpAppointmentConfirmationDelivery(smtp.config), signal = new AbortController().signal;
      const bad: unknown[] = [undefined, [], null, { ...appointment, email: "patient@example.test\r\nBcc: other@example.test" },
        { ...appointment, email: undefined }, { ...appointment, clinicName: "Clinic\r\n." }, { ...appointment, locationName: "Branch\u202e" },
        { ...appointment, patientId: "123" }, { ...appointment, appointmentTypeName: "" },
        { ...appointment, startsAt: "2026-02-30T12:30:00Z" }, { ...appointment, endsAt: appointment.startsAt },
        { ...appointment, timeZone: "Wrong/Zone" }, { ...appointment, practitionerName: "X".repeat(256) }];
      for (const value of bad) assert.deepEqual(await delivery.send(value as AppointmentConfirmationMail, signal), { kind: "definitiveUnsent" });
      const stop = new AbortController(); stop.abort();
      assert.deepEqual(await delivery.send(appointment, stop.signal), { kind: "definitiveUnsent" });
      assert.equal(smtp.commands.length, 0);
    });
  });
  test("E2E-370 certificate failures do not expose SMTP credentials or send details", async () => {
    await withSmtpVerificationServer(async smtp => {
      assert.deepEqual(await new SmtpAppointmentConfirmationDelivery(smtp.config).send(appointment, new AbortController().signal), { kind: "definitiveUnsent" });
      assert.equal(smtp.commands.length, 0);
    }, "wrong");
  });
  test("E2E-370 post-body abort is uncertain and timeout results reflect the observed submission phase", async () => {
    await withSmtpVerificationServer(async smtp => {
      smtp.fault("stallData"); const stop = new AbortController();
      const pending = new SmtpAppointmentConfirmationDelivery(smtp.config).send(appointment, stop.signal);
      await smtp.receivedData; stop.abort();
      assert.deepEqual(await pending, { kind: "unknown" }); assert.equal(smtp.messages.length, 1);
    });
    await withSmtpVerificationServer(async smtp => {
      smtp.fault("stallData");
      const result = await new SmtpAppointmentConfirmationDelivery({ ...smtp.config, timeoutMs: 100 }).send(appointment, new AbortController().signal);
      // A loaded machine may exhaust the same 100ms transaction deadline during TLS/auth.
      // Completed body evidence must be unknown; pre-body expiry must never claim acceptance.
      assert.ok(result.kind === "unknown" || result.kind === "definitiveUnsent");
      if (smtp.messages.length === 1) assert.deepEqual(result, { kind: "unknown" });
      if (result.kind === "definitiveUnsent") assert.equal(smtp.messages.length, 0);
      if (result.kind === "unknown") assert.equal(smtp.commands.filter(command => command === "DATA").length, 1);
    });
    await withSmtpVerificationServer(async smtp => {
      smtp.fault("stallGreeting");
      assert.deepEqual(await new SmtpAppointmentConfirmationDelivery({ ...smtp.config, timeoutMs: 100 }).send(appointment, new AbortController().signal), { kind: "definitiveUnsent" });
      assert.equal(smtp.messages.length, 0);
    });
  });
  test("E2E-370 shared transport escapes dot terminators and rejects unsafe subject lines", async () => {
    await withSmtpVerificationServer(async smtp => {
      const transport = new SmtpTextMailTransport(smtp.config), signal = new AbortController().signal;
      assert.deepEqual(await transport.submit(appointment.email, "Subject\r\nBcc: other@example.test", "text", signal), { kind: "definitiveUnsent" });
      assert.deepEqual(await transport.submit(undefined as unknown as string, "Subject", "text", signal), { kind: "definitiveUnsent" });
      assert.equal(smtp.commands.length, 0);
      assert.equal((await transport.submit(appointment.email, "Subject", "first\n.\n..next\nlast", signal)).kind, "accepted");
      assert.equal(smtp.messages.length, 1);
      assert.equal(body(smtp.messages[0]!), "first\r\n..\r\n...next\r\nlast");
    });
  });
});
