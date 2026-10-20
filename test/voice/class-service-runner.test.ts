import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 };
describe("compiled multiple class service selection", { concurrency: 2 }, () => {
  for (const operation of ["book", "cancel"] as const)
    test(`E2E-396 compiled ${operation} chooses the second class through played service/time/fee consent and exact native receipt`, options, async () => {
      await withClinicalRunner(operation, async call => {
        await call.say("Start");
        assert.match(call.spoken.at(-1)!, /Mat Pilates.*Demo Instructor.*60 minutes.*Reformer Pilates.*Second Instructor.*30 minutes/);
        assert.equal(call.messages.some(row => row.kind === "verificationEmail"), false);
        await call.mark(); await call.say("The second class please");
        assert.match(call.spoken.at(-1)!, /six-digit code.*keypad/);
        await call.mark(); await call.verify();
        if (operation === "book") { await call.say("Times"); await call.mark(); await call.say("The first time please."); }
        else { await call.say("Appointments"); await call.mark(); await call.say("Cancel that appointment."); }
        assert.match(call.spoken.at(-1)!, /Reformer Pilates.*Second Instructor/);
        assert.equal(call.mutations.length, 0);
        await call.mark(); await call.say("Yes");
        const writes = call.mutations.filter(row => row.path?.startsWith("/v1/attendees"));
        assert.equal(writes.length, 1);
        if (operation === "book") assert.equal(writes[0]!.body?.booking_id, "191");
        else { assert.equal(writes[0]!.path, "/v1/attendees/201/cancel"); assert.equal(writes[0]!.body?.apply_to_repeats, false); }
        assert.equal(call.spoken.at(-1)!, operation === "book" ? "Your booking is confirmed." : "Your appointment cancellation is confirmed.");
        const review = call.mutations.filter(row => row.path === "/v1/recalls"); assert.equal(review.length, 1);
        assert.equal(resultValue(decodeClinikoReview(review[0]!.body?.notes)).request.operation.kind, operation === "book" ? "classBook" : "classCancel");
        assert.equal(call.messages.some(row => row.kind === "providerRequest" && row.path?.includes("individual_appointments")), false);
        const code = call.messages.find(row => row.kind === "verificationEmail")!.code!;
        await call.scan([code, ...verificationCanaries]);
      }, { classes: true, multipleClasses: true });
    });
});
