import assert from "node:assert/strict";
import { financialClassVoiceJourney } from "./financial-class-voice-journey.ts";
import { withRetainedFinancialCaller } from "./financial-caller-context.ts";
import type { FinancialCallerActor } from "./financial-caller-context.ts";

export async function withClassFinancialCaller(passes: boolean, stage: (value: number) => void,
  run: (context: FinancialCallerActor) => Promise<void>): Promise<void> {
  stage(1);
  await financialClassVoiceJourney(passes, async ({ booking: f, db, connectionString }) => {
    stage(2);
    const observation = f.proof(); assert.equal(observation.targetRef, "cliniko:attendee:401");
    assert.deepEqual(observation.classCreationRequest, { sessionId: "94", ...(passes ? { patientCaseId: f.pass.caseId } : {}) });
    assert.equal(f.writes[0]!.booking_id, "94");
    await withRetainedFinancialCaller({ native: f.funding, observation,
      expected: { targetRef: "cliniko:attendee:401", amount: 1200, currency: "gbp" },
      clock: f.classSessionConfig.clock, setTime: f.setTime, clinicalWrites: () => f.writes, reviews: () => f.recalls },
      db, connectionString, stage, run);
  });
}
