import assert from "node:assert/strict";
import test from "node:test";
import { bookingServiceQuestionText } from "../../src/core/booking-service-question.ts";
import { startsServiceDialogue } from "../../src/standalone/booking-service-dialogue.ts";

test("E2E-348 public selection questions cannot contain private references, invented fields or unbounded lengths", () => {
  assert.match(bookingServiceQuestionText({ field: "durationMinutes", options: ["45", "60"] })!, /45 or 60 minutes/);
  for (const question of [{ field: "name", options: ["/private/source.json"] }, { field: "durationMinutes", options: ["900"] },
    { field: "durationMinutes", options: ["60", "60"] }, { field: "visitKind", options: ["best"] },
    { field: "newProblem", options: ["false"] }, { field: "name", options: ["Massage"], providerId: "35" }])
    assert.equal(bookingServiceQuestionText(question as never), undefined);
  assert.equal(startsServiceDialogue("I'd like to book an appointment."), true);
  assert.equal(startsServiceDialogue("I don't want to book an appointment."), false);
  assert.equal(startsServiceDialogue('They said "book an appointment".'), false);
});
