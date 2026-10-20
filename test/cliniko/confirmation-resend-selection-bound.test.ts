import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createDisposablePostgres } from "../support/disposable-postgres.ts";
import { confirmationResendFixture } from "../support/confirmation-resend.ts";
import { resendWorkflow } from "../support/confirmation-resend-workflow.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const database = await createDisposablePostgres(); after(() => database.close());
const content = { template: "appointmentDetails.v2" as const, contentKinds: ["activeInPerson", "activeTelehealth", "cancelled"] as const };
const cancelledAt = "2026-10-02T06:00:00.000Z";
for (const period of ["active", "pastCancelled", "futureCancelled"] as const)
test(`a played ${period} selection refreshes its native range once before exact private evidence`, async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(database.db, smtp.config, "appointments.resend", true, undefined, undefined, content);
    let w: Awaited<ReturnType<typeof resendWorkflow>> | undefined;
    try {
      f.setChoices([{ id: "81", starts_at: period === "pastCancelled" ? "2026-10-03T04:00:00.000Z" : "2026-10-08T04:00:00.000Z",
        ends_at: period === "pastCancelled" ? "2026-10-03T04:30:00.000Z" : "2026-10-08T04:30:00.000Z",
        ...(period !== "active" ? { cancelled_at: cancelledAt } : {}) }]);
      w = await resendWorkflow(f); await w.verify(); resultValue(await w.flow.listResendAppointments());
      const before = f.traffic.length, readbacks = f.readbacks.length;
      const selected = resultValue(await w.flow.selectResendAppointment(1)); assert.ok(selected.requestRef);
      const reads = f.traffic.slice(before);
      assert.equal(reads.filter(path => path === "GET /v1/individual_appointments").length, 1);
      assert.ok(reads.filter(path => path === "GET /v1/individual_appointments/81").length >= 4,
        "both exact evidence reads still bracket private playback");
      assert.ok(f.readbacks.length > readbacks); assert.equal(f.recalls.length, 0); assert.equal(smtp.messages.length, 0);
    } finally { w?.flow.dispose(); await f.close(); }
  });
});

for (const fault of ["retimed", "restored", "cancellationChanged", "foreignPatient", "foreignBusiness", "archived", "permission"] as const)
test(`a cancelled selection ${fault} before refresh cannot disclose a new private readback`, async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await confirmationResendFixture(database.db, smtp.config, "appointments.resend", true, undefined, undefined, content);
    let w: Awaited<ReturnType<typeof resendWorkflow>> | undefined;
    try {
      const original = { id: "81", starts_at: "2026-10-03T04:00:00.000Z", ends_at: "2026-10-03T04:30:00.000Z", cancelled_at: cancelledAt };
      f.setChoices([original]); w = await resendWorkflow(f); await w.verify(); resultValue(await w.flow.listResendAppointments());
      const readbacks = f.readbacks.length;
      if (fault === "retimed") f.setChoices([{ ...original, starts_at: "2026-10-03T05:00:00.000Z", ends_at: "2026-10-03T05:30:00.000Z" }]);
      if (fault === "restored") f.setChoices([{ ...original, cancelled_at: null }]);
      if (fault === "cancellationChanged") f.setChoices([{ ...original, cancelled_at: "2026-10-02T07:00:00.000Z" }]);
      if (fault === "foreignPatient") f.setAppointment({ patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/99" } } });
      if (fault === "foreignBusiness") f.setAppointment({ business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/99" } } });
      if (fault === "archived") f.setAppointment({ archived_at: cancelledAt });
      if (fault === "permission") f.setPermitted(false);
      assert.equal((await w.flow.selectResendAppointment(1)).ok, false);
      assert.equal(f.readbacks.length, readbacks); assert.equal(w.flow.confirmationResendRef, undefined);
      assert.equal(f.recalls.length, 0); assert.equal(smtp.messages.length, 0);
    } finally { w?.flow.dispose(); await f.close(); }
  });
});
