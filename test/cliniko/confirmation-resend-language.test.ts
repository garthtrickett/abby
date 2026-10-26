import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmationResendLanguage } from "../../src/standalone/confirmation-resend-language.ts";

test("E2E-375 only an explicit appointment-email send request enters the resend workflow", () => {
  for (const text of ["Please resend my cancelled appointment confirmation email.", "Resend my virtual appointment details", "Please resend my telehealth appointment confirmation email.", "Please resend my confirmation email.", "Can you resend my appointment confirmation?", "Send my appointment email", "Please send me the appointment details again"]) assert.equal(confirmationResendLanguage(text), "request");
  for (const text of ["I haven't received my email", "Did you send my appointment email?", "Check my confirmation email", "Don't resend my appointment email", "Email confirmation", "Send my blood results", "Send my appointment email and cancel tomorrow", "Cancel my appointment", "Resend my cancelled appointment email and book tomorrow"]) assert.equal(confirmationResendLanguage(text), undefined);
  for (const text of ["Resend my appointment email to a different address", "Send my confirmation email to other@example.test", "Send my appointment details to my wife"]) assert.equal(confirmationResendLanguage(text), "unsupportedRecipient");
});

test("E2E-381 another appointment resend is distinct from another recipient or a delivery question", () => {
  for (const text of ["Please send the confirmation email for another appointment.", "Can you resend my appointment details for another appointment?",
    "Resend the confirmation email for another appointment"])
    assert.equal(confirmationResendLanguage(text), "anotherAppointment");
  for (const text of ["Don't send the confirmation email for another appointment", "Did you send the confirmation email for another appointment?"])
    assert.equal(confirmationResendLanguage(text), undefined);
  for (const text of ["Send the confirmation email for another appointment to my wife", "Send the confirmation email for another appointment to other@example.test",
    "Did you resend my appointment details to alternate-private@example.test?", "Have you sent my appointment details to my wife?",
    "Was the confirmation email sent to another address?", "Did you resend my confirmation email for another appointment to other@example.test?"])
    assert.equal(confirmationResendLanguage(text), "unsupportedRecipient");
});
