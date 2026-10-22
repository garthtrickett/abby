import assert from "node:assert/strict";
import test from "node:test";
import { TwilioOutboundUnansweredObservationAuthentication, twilioOutboundUnansweredActionRef,
  encodeTwilioOutboundUnansweredObservation, decodeTwilioOutboundUnansweredObservation } from "../../src/cliniko/twilio-outbound-unanswered-observation.ts";
import { encodeTwilioOutboundTerminalObservation, decodeTwilioOutboundTerminalObservation } from "../../src/cliniko/twilio-outbound-terminal-observation.ts";
import { twilioOutboundTerminalObservationValue } from "../support/twilio-outbound-terminal-observation.ts";
import { value } from "../support/outbound-records.ts";

test("unanswered provenance has a separate stable action and authenticated native format", () => {
  const f = twilioOutboundTerminalObservationValue(), auth = new TwilioOutboundUnansweredObservationAuthentication(f.key, f.auth.binding());
  const unsigned = { ...f.unsigned, status: "no-answer" as const, actionRef: twilioOutboundUnansweredActionRef(f.unsigned.sessionActionRef)! };
  const record = value(auth.sign(unsigned)), notes = value(encodeTwilioOutboundUnansweredObservation(record));
  assert.equal(auth.verify(value(decodeTwilioOutboundUnansweredObservation(notes))), true);
  assert.notEqual(record.actionRef, f.observation.actionRef); assert.notEqual(auth.authenticationBinding(), f.auth.authenticationBinding());
  assert.equal(auth.matchesOriginal(record, f.context, record.accountSid), true);
  assert.equal(decodeTwilioOutboundTerminalObservation(notes).ok, false);
  assert.equal(decodeTwilioOutboundUnansweredObservation(value(encodeTwilioOutboundTerminalObservation(f.observation))).ok, false);
  assert.equal(auth.verify({ ...record, patientId: "999" }), false);
  assert.equal(auth.verify({ ...record, authentication: f.observation.authentication }), false);
  for (const forbidden of [{ complete: true }, { endedAt: record.receivedAt }, { contact: "completeNoStop" }, { patientVerified: true },
    { status: "completed" }, { status: "busy" }, { status: "failed" }, { status: "canceled" }])
    assert.equal(auth.sign({ ...unsigned, ...forbidden } as typeof unsigned).ok, false);
  assert.equal(Reflect.set(auth, "verify", () => true), false);
  assert.equal(Object.isFrozen(record), true); assert.equal(Object.isFrozen(record.scope), true);
});
