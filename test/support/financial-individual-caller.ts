/** Real individual signed caller; preserve its own native intent/ACK through
 * the same independently owned financial outcomes as native class callers. */
import assert from "node:assert/strict";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import type { FinancialBookingPreparationConfig } from "../../src/standalone/cliniko-financial-booking-preparation.ts";
import { declareClinikoRequestCost } from "../../src/cliniko/request-cost.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { decodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import { verifyFinancialBookingObservation } from "../../src/cliniko/financial-booking-observation.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { bookingCallFlowFixture } from "./cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "./cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "./disposable-postgres.ts";
import { fixture, intentValue, keys, keyRef, value } from "./financial-retention.ts";
import { withRetainedFinancialCaller } from "./financial-caller-context.ts";
import { runPaidFinancialCaller } from "./financial-class-caller-chain.ts";
import { runUnpaidFinancialCaller } from "./financial-class-unpaid-chain.ts";

export async function financialIndividualCaller(outcome: "paid" | "closedUnpaid", stage: (value: number) => void): Promise<void> {
  stage(1); const callerBegan = performance.now();
  await withDisposablePostgres(async (db, connectionString) => {
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-session-au5", maxPerMinute: 180 });
    const f = await bookingCallFlowFixture({ budget }); f.flow.dispose();
    const financialLife = new AbortController();
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    let readClock = f.config.clock;
    const funding = fixture({ intent: { ...intentValue(), scope: f.scope },
      config: { scope: f.scope, apiKey: f.config.cliniko.apiKey, businessId: f.config.cliniko.businessId,
        contactEmail: f.config.cliniko.contactEmail, rateBudget: budget, clock: () => readClock() },
      barrierFactory: native => new PostgresFinancialEffectBarrier(db, native.scope, value(financialRecordOwnerBinding(native))),
      response: (row, method) => { if (method === "POST") { row.created_at = readClock(); row.updated_at = row.created_at; }
        return Response.json(row, { status: method === "POST" ? 201 : 200 }); } });
    const base = f.flowConfig.fetchPort!;
    const provider: typeof fetch = async (input, init) => {
      const url = new URL(String(input)), body = init?.method === "POST" ? JSON.parse(String(init.body)) : undefined;
      if (url.pathname === "/v1/recalls" && body?.recall_type_id === "40" ||
          url.pathname.startsWith("/v1/recalls/") && funding.rows.has(url.pathname.split("/").at(-1)!)) return funding.port(input, init);
      if (url.pathname === "/v1/recalls" && init?.method === "GET" && url.searchParams.getAll("q[]").some(q => q.startsWith("patient_id:="))) {
        const rows = [...funding.rows.values(), ...f.recalls.map(row => ({ ...row, links: { self: `${url.origin}/v1/recalls/${row.id}` }, created_at: readClock(), updated_at: readClock() }))]
          .sort((a, b) => Number(a.id) - Number(b.id));
        const page = Number(url.searchParams.get("page") ?? 1); return Response.json({ total_entries: rows.length, recalls: rows.slice((page - 1) * 100, page * 100) });
      }
      return base(input, init);
    };
    const binding = { scope: f.scope, credentialFingerprint: clinikoCredentialFingerprint(f.config.cliniko.apiKey), budget };
    const financial: FinancialBookingPreparationConfig = { native: funding.config, privateKey: keys.privateKey,
      financialSignal: financialLife.signal, fetchPort: provider, barrier: funding.barrier,
      sourceAuthorized: declareClinikoRequestCost(async () => true, binding, 0),
      authority: { ...funding.authority, allows: declareClinikoRequestCost(funding.authority.allows.bind(funding.authority), binding, 0),
        producerAdmitted: declareClinikoRequestCost(funding.authority.producerAdmitted.bind(funding.authority), binding, 0) },
      policy: { quote: async selection => ({ kind: "required", payment: { amount: 5000, currency: "gbp", policyVersion: "fee-policy-1", termsVersion: "financial-terms-1", deadline: "2026-10-05T04:00:00.000Z" },
        recipient: { kind: "email", address: "financial-recipient@example.invalid" }, approvedTerms: "The clinic will review late payment; no automatic refund is promised.", reviewDate: "2026-10-05", expiresAt: selection.expiresAt }),
        current: declareClinikoRequestCost(async () => true, binding, 0), currentForSend: () => true },
      presentation: { play: async () => { assert.fail("the actual admitted caller must supply financial playback"); } } };
    const seen: string[] = [];
    const model: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)), text = JSON.parse(request.input[1].content).callerText; seen.push(text);
      const decision = { kind: "unsupported", operation: null as string | null, stage: null, from: null as string | null, to: null as string | null, choice: null as number | null };
      if (text === "I need to book an appointment.") { decision.kind = "workflow"; decision.operation = "book"; }
      else if (text === "What times are available on October 8?") { decision.kind = "menu"; decision.from = "2026-10-08"; decision.to = "2026-10-08"; }
      else if (text === "The second time, please.") { decision.kind = "choice"; decision.choice = 2; }
      else assert.fail("unexpected ordinary classification; financial resume must stay local");
      return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
    };
    try {
      let callerTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([(async () => {
          call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, financial, fetchPort: provider }, owner =>
            createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: model }), { clinicalHost: true });
          readClock = call.currentTime;
          await call.turn("I need to book an appointment."); await call.mark();
          await voiceUntil(() => f.mail.length === 1, "actual individual verification mail"); await call.verify(f.mail[0]!.code);
          await call.turn("What times are available on October 8?"); await call.mark(); await call.turn("The second time, please."); await call.mark();
          const input = call.flow.financialBookingInput; assert.ok(input); let parts = 0;
          while (input.inputAdmission()?.phase === "unplayed" && parts++ < 16) {
            const frames = call.transcriptionFrames; await call.privateDigit("1");
            call.media(true); for (let i = 0; i < 5; i++) call.media(false);
            await call.privateKey("1"); assert.equal(input.readySelection, undefined); assert.equal(call.transcriptionFrames, frames);
            await call.mark(); await voiceUntil(() => input.inputAdmission() !== undefined || !input.inputActive, "actual individual financial played mark");
          }
          assert.ok(parts > 2); assert.equal(input.inputAdmission()?.phase, "awaiting");
          assert.equal(call.writes.length, 0); assert.equal(Object.keys((await call.state()).actions).length, 0);
          await call.privateKey("1"); await call.privateQuiet(); assert.ok(input.readySelection);
          await call.turn("continue booking"); assert.equal(seen.includes("continue booking"), false); await call.mark();
          assert.equal(Object.values((await call.state()).actions).at(-1)?.status, "awaitingConfirmation");
          await call.turn("Yes");
          assert.deepEqual(call.writes, ["POST /v1/individual_appointments"]);
          assert.equal(Object.values((await call.state()).actions).at(-1)?.status, "committed");
          for (const secret of ["financial-recipient@example.invalid", "GBP 50.00"])
            assert.equal(JSON.stringify([call.modelTurns, call.transcripts, seen, await call.state()]).includes(secret), false);
        })(), new Promise<never>((_, reject) => { callerTimer = setTimeout(() => { reject(new Error("original individual caller deadline")); void call?.close(); }, Math.max(1,120_000-(performance.now()-callerBegan))); })]);
      } finally { if (callerTimer) clearTimeout(callerTimer); }
      assert.ok(call); const requests = call.writeRequests; assert.equal(requests.length, 1);
      const row = [...funding.rows.values()].find(row => String(row.notes).includes("financial intent"))!;
      const intent = value(decodeClinikoFinancialIntent(row.notes)); assert.equal(intent.booking.kind, "book");
      const noted = [...funding.rows.values()].find(row => String(row.notes).includes("financial booking observation"))!;
      const observation = value(verifyFinancialBookingObservation(noted.notes, { intent, intentRecallRef: `cliniko:recall:${row.id}`, producerKeyRef: keyRef, publicKey: keys.publicKey }));
      assert.equal(observation.targetRef, "cliniko:appointment:91"); assert.equal(observation.classCreationRequest, undefined); assert.ok(observation.financialConsent);
      await call.close(); call = undefined; stage(2);
      await withRetainedFinancialCaller({ native: funding, observation, expected: { targetRef: "cliniko:appointment:91", amount: 5000, currency: "gbp" },
        clock: () => readClock(), setTime: f.setTime, clinicalWrites: () => requests, reviews: () => f.recalls },
        db, connectionString, stage, context => (outcome === "paid" ? runPaidFinancialCaller : runUnpaidFinancialCaller)(context, stage));
    } finally { if (call) await call.close(); financialLife.abort(); await f.close(); }
  });
}
