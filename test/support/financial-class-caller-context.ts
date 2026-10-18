/** Actual original caller and outliving native/financial actor. Both money
 * outcomes cross this same provenance, physical-budget and persistence seam. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { financialClassVoiceJourney } from "./financial-class-voice-journey.ts";
import type { FinancialClassVoiceBooking } from "./financial-class-voice-journey.ts";
import { financialConsumerFixture } from "./financial-consumer.ts";
import { decodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { value } from "./financial-retention.ts";

type Actor = Readonly<{
  actor: Awaited<ReturnType<typeof financialConsumerFixture>>;
  observation: ReturnType<FinancialClassVoiceBooking["booking"]["proof"]>;
  clock(): string; advanceTo(instant: string): void;
  directory: string; connectionString: string; db: FinancialClassVoiceBooking["db"];
}>;
export async function withClassFinancialCaller(passes: boolean, stage: (value: number) => void,
  run: (context: Actor) => Promise<void>): Promise<void> {
  stage(1);
  await financialClassVoiceJourney(passes, async ({ booking: f, db, connectionString }) => {
    stage(2);
    const observation = f.proof(); assert.equal(observation.targetRef, "cliniko:attendee:401");
    assert.deepEqual(observation.classCreationRequest, { sessionId: "94", ...(passes ? { patientCaseId: f.pass.caseId } : {}) });
    const intentRow = f.funding.rows.get(observation.intentRecallRef.split(":").at(-1)!)!;
    const intent = value(decodeClinikoFinancialIntent(intentRow.notes));
    const observationRow = [...f.funding.rows.values()].find(row => String(row.notes).includes("financial booking observation"))!;
    assert.notEqual(intent.actionRef, f.funding.intent.actionRef);
    assert.equal(intent.payment.amount, 1200); assert.equal(intent.payment.currency, "gbp");
    const originalNotes = [intentRow.notes, observationRow.notes], originalWrites = structuredClone(f.writes);
    assert.equal(originalWrites.length, 1); assert.equal(originalWrites[0]!.booking_id, "94");
    const began = performance.now(), anchor = Math.max(Date.parse(f.classSessionConfig.clock()), Date.parse(observation.observedAt));
    let offset = 0;
    const clock = () => { const now = new Date(anchor + offset + performance.now() - began).toISOString(); f.setTime(now); return now; };
    const advanceTo = (instant: string) => {
      const target = Date.parse(instant), current = Date.parse(clock());
      assert.ok(Number.isFinite(target) && new Date(target).toISOString() === instant && target >= current);
      offset += target - current; clock();
    };
    clock();
    const directory = await mkdtemp(join(tmpdir(), "abby-caller-finance-"));
    let actor: Awaited<ReturnType<typeof financialConsumerFixture>> | undefined, timer: ReturnType<typeof setInterval> | undefined;
    try {
      actor = await financialConsumerFixture({ checkout: { retained: { native: f.funding, intent,
        binding: { intentRecallRef: observation.intentRecallRef, financialActionRef: intent.actionRef,
          observationRecallRef: `cliniko:recall:${observationRow.id}`, observationActionRef: observation.actionRef, reviewDate: "2026-10-05" },
        otherReviews: () => f.recalls.map(row => ({ ...row, recalled_at: null, archived_at: null,
          links: { self: `https://api.au5.cliniko.com/v1/recalls/${row.id}` }, created_at: observation.observedAt, updated_at: observation.observedAt })) } } });
      await actor.consumer.close(); timer = setInterval(clock, 25);
      await run({ actor, observation, clock, advanceTo, directory, connectionString, db });
      assert.equal(actor.sessions.length, 1); assert.equal(actor.receipts.length, 1);
      assert.deepEqual([intentRow.notes, observationRow.notes], originalNotes); assert.deepEqual(f.writes, originalWrites);
      assert.deepEqual(await readdir(directory), []);
      const budgets = await db.selectFrom("cliniko_request_budgets").selectAll().execute();
      assert.equal(budgets.length, 1); assert.equal(budgets[0]!.max_per_minute, 180);
      assert.ok(Array.isArray(budgets[0]!.sent_at_ms) && budgets[0]!.sent_at_ms.length <= 180);
      const canaries = [intent.recipient.address, observation.financialConsent!.presentationDigest, observation.intentDigest,
        "cs_test_owner", "private-checkout-token", "private-consumer", "Abby financial intent v1", "Abby financial booking observation v3"];
      assert.deepEqual(value(await scanPatientDataCanaries(db, canaries.map((value, i) => ({ label: `chain_${i}`, value })))), []);
      const dump = execFileSync("pg_dump", [connectionString, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
      for (const canary of [...canaries, ...originalNotes.map(String)]) assert.equal(dump.includes(canary), false);
      stage(7);
    } finally {
      if (timer) clearInterval(timer); await actor?.consumer.close(); await rm(directory, { recursive: true, force: true });
    }
  });
}
