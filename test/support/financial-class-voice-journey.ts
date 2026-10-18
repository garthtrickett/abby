import assert from "node:assert/strict";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { financialClassBookingFixture } from "./financial-class-booking.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "./cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "./disposable-postgres.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";


/** Shared source/compiled signed-serving journey. Keep every assertion at this seam. */
type FinancialVoiceResource = Parameters<Parameters<typeof withDisposablePostgres>[0]>;
export type FinancialClassVoiceBooking = Readonly<{
  booking: Awaited<ReturnType<typeof financialClassBookingFixture>>;
  db: FinancialVoiceResource[0]; connectionString: FinancialVoiceResource[1];
}>;
export async function financialClassVoiceJourney(passes: boolean,
  afterBooking?: (context: FinancialClassVoiceBooking) => Promise<void>): Promise<void> {
  const callerBegan = performance.now();
  await withDisposablePostgres(async (db, connectionString) => {
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-class-au5", maxPerMinute: 180 });
    const f = await financialClassBookingFixture({ passes, budget, barrierFor: native => new PostgresFinancialEffectBarrier(db, native.scope, resultValue(financialRecordOwnerBinding(native))) });
    f.host.dispose(); f.session.dispose();
    // A legacy/shared callback cannot stand in for this admitted call's actual
    // private played receipt; the real host must replace it with the call port.
    assert.equal(Reflect.set(f.flowConfig.financial!.presentation, "play", async () => { assert.fail("shared financial playback must not be used"); }), true);
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    const modelInputs: string[] = [];
    let financialText: string | undefined;
    try {
      const caller = async () => {
        const model: typeof fetch = async (_input, init) => {
          const body = JSON.parse(String(init?.body)), context = JSON.parse(body.input[1].content); modelInputs.push(context.callerText);
          const decision = { kind: "unsupported", operation: null as string | null, stage: null, from: null as string | null, to: null as string | null, choice: null as number | null };
          if (context.callerText === "I would like a place in Mat Pilates.") { decision.kind = "classWorkflow"; decision.operation = "book"; }
          else if (context.callerText === "Show class times on October 8.") { decision.kind = "menu"; decision.from = "2026-10-08"; decision.to = "2026-10-08"; }
          else if (context.callerText === "The first time please.") { decision.kind = "choice"; decision.choice = 1; }
          else assert.fail("Unexpected classifier request; financial resume must stay local");
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
        };
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: model }), { clinicalHost: true });
        f.bindNativeCall(() => call!.state());
        await call.turn("I would like a place in Mat Pilates."); await call.mark(); await f.verificationDelivered; await call.verify(f.mail[0]!.code);
        await call.turn("Show class times on October 8."); await call.mark(); await call.turn("The first time please."); await call.mark();
        assert.equal(Object.keys((await call.state()).actions).length, 0); assert.equal(call.writes.length, 0);
        const financial = call.flow.financialBookingInput; assert.ok(financial);
        let parts = 0;
        while (financial.inputAdmission()?.phase === "unplayed" && parts++ < 16) {
          const frames: number = call.transcriptionFrames;
          await call.privateDigit("1");
          call.media(true); for (let i = 0; i < 5; i++) call.media(false);
          await call.privateKey("1"); assert.equal(financial.readySelection, undefined); assert.equal(call.transcriptionFrames, frames);
          await call.mark(); await voiceUntil(() => financial.inputAdmission() !== undefined || !financial.inputActive, "financial part actual played acknowledgement");
        }
        assert.ok(parts > 2); assert.equal(financial.inputAdmission()?.phase, "awaiting"); assert.equal(financial.readySelection, undefined);
        assert.equal(Object.keys((await call.state()).actions).length, 0); await call.privateKey("1"); await call.privateQuiet();
        assert.ok(financial.readySelection); assert.equal(call.writes.length, 0);
        await call.turn("continue booking"); assert.equal(modelInputs.includes("continue booking"), false); await call.mark();
        assert.equal(Object.values((await call.state()).actions).at(-1)?.status, "awaitingConfirmation");
        await call.turn("Yes");
        const wait = /wait about (\d+) seconds/.exec(call.spoken.at(-1)!);
        if (wait) {
          assert.equal(call.writes.length, 0); await call.mark(); const seconds = Number(wait[1]); assert.ok(seconds >= 1 && seconds <= 60);
          let now = Date.parse(f.classSessionConfig.clock());
          const ticker = setInterval(() => { now += 1_000; f.setTime(new Date(now).toISOString()); }, 1_000);
          const quiet = setInterval(() => call!.media(false), 20);
          try { await new Promise<void>(resolve => setTimeout(resolve, seconds * 1_000 + 500)); }
          finally { clearInterval(ticker); clearInterval(quiet); }
          assert.equal(call.writes.length, 0); await call.turn("Yes");
        }
        assert.deepEqual(call.writes, ["POST /v1/attendees"]); assert.equal(Object.values((await call.state()).actions).at(-1)?.status, "committed");
        assert.equal(f.proof().targetRef, "cliniko:attendee:401"); assert.ok(f.proof().financialConsent);
        const nativeBudgets = await db.selectFrom("cliniko_request_budgets").selectAll().execute();
        assert.equal(nativeBudgets.length, 1); assert.equal(nativeBudgets[0]!.max_per_minute, 180);
        assert.ok(Array.isArray(nativeBudgets[0]!.sent_at_ms) && nativeBudgets[0]!.sent_at_ms.length <= 180);
        const privateText = call.spoken.find(text => text.includes("GBP 12.00")); assert.ok(privateText);
        for (const secret of ["class-financial-recipient@example.invalid", "GBP 12.00", f.pass.caseId, f.pass.entitlementRef]) {
          assert.equal(JSON.stringify([call.modelTurns, call.transcripts, modelInputs, await call.state()]).includes(secret), false);
        }
        financialText = privateText;
        await call.close(); call = undefined;
      };
      let callerTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (afterBooking) await Promise.race([caller(), new Promise<never>((_, reject) => {
          callerTimer = setTimeout(() => {
            reject(new Error("original caller financial stage deadline")); void call?.close();
          }, Math.max(1, 120_000 - (performance.now() - callerBegan)));
        })]);
        else await caller();
      } finally { if (callerTimer) clearTimeout(callerTimer); }
      assert.ok(financialText);
      await afterBooking?.({ booking: f, db, connectionString });
      assert.deepEqual(resultValue(await scanPatientDataCanaries(db, [
        { label: "financial_recipient", value: "class-financial-recipient@example.invalid" }, { label: "financial_text", value: financialText },
        { label: "class_case", value: f.pass.caseId }, { label: "class_entitlement", value: f.pass.entitlementRef },
        { label: "financial_proof", value: f.proof().financialConsent!.presentationDigest },
      ])), []);
    } finally { if (call) await call.close(); await f.close(); }
  });
}
