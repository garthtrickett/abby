import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmationResendLanguage } from "../../src/standalone/confirmation-resend-language.ts";

test("E2E-375 only an explicit appointment-email send request enters the resend workflow", () => {
  for (const text of ["Please resend my confirmation email.", "Can you resend my appointment confirmation?", "Send my appointment email", "Please send me the appointment details again"]) assert.equal(confirmationResendLanguage(text), "request");
  for (const text of ["I haven't received my email", "Did you send my appointment email?", "Check my confirmation email", "Don't resend my appointment email", "Email confirmation", "Send my blood results", "Send my appointment email and cancel tomorrow"]) assert.equal(confirmationResendLanguage(text), undefined);
  for (const text of ["Resend my appointment email to a different address", "Send my confirmation email to other@example.test", "Send my appointment details to my wife"]) assert.equal(confirmationResendLanguage(text), "unsupportedRecipient");
});
