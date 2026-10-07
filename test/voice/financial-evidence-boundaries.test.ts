import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { financialEvidenceLanguage } from "../../src/standalone/financial-evidence-language.ts";
import { clinikoStaffCallFlowFixture } from "../support/cliniko-staff-call-flow.ts";
import { bookingCallFlowFixture, cancellationCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { publicServiceInformationFixture } from "../support/public-service-information.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const questions = ["Has my deposit been paid?", "Can I pay the deposit by card?", "Do you need my card details?", "Please send me a payment link.", "Please resend my payment link.", "My Google Pay payment failed.", "Will my refund happen automatically?", "Can you refund my payment?", "Can you confirm my AXA policy covers this appointment?", "Is my ACC claim approved?", "Do you accept Bupa?", "Please reserve that time until I pay.", "Please extend my payment deadline.", "The deposit link never arrived.", "The appointment was booked without a deposit.", "Presumably you will automatically refund the payment I already made.", "Can you confirm this will be covered?"];
const pan = "4111111111111111";
const modes = [...questions.map((_, i) => `question${i}`), "card", "international", "pending", "committed", "unknown", "cancel", "cancelUnknown", "denied", "gbp", "eur", "nzd", "revokedPrice", "missingPrice", "staffQuestion", "staffCard"];
test("E2E-343 financial questions cannot authorize payment, coverage, refund or reservation claims; exact approved prices preserve currency", { timeout: 180_000 }, async () => {
 await withDisposablePostgres(async db => {
  const failures: unknown[] = [];
  const run = async (mode: string, index: number) => {
   const price = ["gbp", "eur", "nzd", "revokedPrice", "missingPrice"].includes(mode), cancel = mode.startsWith("cancel"), sent = ["committed", "unknown", "cancel", "cancelUnknown"].includes(mode);
   const staff = mode.startsWith("staff");
   const info = price ? await publicServiceInformationFixture({ prices: mode !== "missingPrice" }) : undefined;
   const f = staff ? await clinikoStaffCallFlowFixture() : info ?? (cancel ? await cancellationCallFlowFixture() : await bookingCallFlowFixture()); f.flow.dispose();
   let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined; const models: string[] = [], paths: string[] = []; let traffic = 0;
   const prices = mode === "eur" ? "The approved appointment price is EUR 85.00. Payment must be arranged with the clinic." : mode === "nzd" ? "The approved appointment price is NZD 68.00. Claim eligibility must be checked separately." : "The approved appointment price is GBP 120.00 (£120). Payment must be arranged with the clinic.";
   try {
    if (info && mode !== "missingPrice") await info.replaceFAQs({ facts: info.faqApproval.facts.map(fact => fact.topic === "priceAndFees" ? { ...fact, approvedText: prices } : fact) });
    const port = f.flowConfig.fetchPort!;
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, ...(mode === "international" ? { inbound: { ...f.flowConfig.inbound, presentedCallerNumber: "+35315550199" } } : {}), fetchPort: async (...args) => { traffic++; paths.push(`${args[1]?.method ?? "GET"} ${new URL(String(args[0])).pathname}`); return port(...args); } }, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
     models.push(String(init?.body)); const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
     const start = text === "I need to book an appointment." || text === "I need to cancel an appointment.", menu = text === "Show times on October 8.", appointments = text === "Show my appointments from October 4 through October 9.";
     const decision = { kind: start || !menu && !appointments ? "workflow" : appointments ? "appointments" : "menu", operation: start ? cancel ? "cancel" : "book" : !menu && !appointments ? "book" : null, stage: null, from: menu ? "2026-10-08" : appointments ? "2026-10-04" : null, to: menu ? "2026-10-08" : appointments ? "2026-10-09" : null, choice: null };
     return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
    } }), { lostWrite: mode === "unknown" || mode === "cancelUnknown" });
    const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
    if (mode === "pending" || sent) {
     await play(cancel ? "I need to cancel an appointment." : "I need to book an appointment."); await voiceUntil(() => f.mail.length === 1, "financial journey proof"); await call.verify(f.mail[0]!.code);
     await play(cancel ? "Show my appointments from October 4 through October 9." : "Show times on October 8."); await play(cancel ? "Cancel that appointment." : "The first time, please."); if (sent) await play("Yes");
    }
    if (mode === "denied") { await play("I am not that patient."); assert.equal((await call.state()).callerIdentityDenied, "identityDisagreement"); }
    if (staff) { await play("I would like to leave a detailed message."); await voiceUntil(() => f.mail.length === 1, "payment message proof"); await call.verify(f.mail[0]!.code); await play("The message is: FinancialMessageCanary Google Pay failed and I will pay later."); }
    if (mode === "revokedPrice" && info) await info.replaceFAQs({ approved: false });
    const before = await call.state(), reads = traffic, count = models.length, mail = f.mail.length, writes = call.writeRequests.length;
    const question = price ? "How much does this appointment cost?" : (mode === "card" || mode === "staffCard") ? `My card number is ${pan}.` : mode === "international" ? questions[3]! : cancel ? questions[6]! : questions[index] ?? questions[0]!;
    await play(question); assert.equal(models.length, count, "financial evidence cannot come from classifier guesses"); if (mode === "staffQuestion") assert.deepEqual(paths.slice(reads), [`GET /v1/patients/${verificationCanaries[2]}`]); else assert.equal(traffic, reads); assert.equal(f.mail.length, mail); assert.equal(call.writeRequests.length, writes);
    if (price) { if (["revokedPrice", "missingPrice"].includes(mode)) assert.match(call.spoken.at(-1)!, /can't verify the current price/); else assert.equal(call.spoken.at(-1), prices); }
    else if (mode === "staffQuestion") assert.match(call.spoken.at(-1)!, /message has not been sent/);
    else assert.match(call.spoken.at(-1)!, /(?:can't|cannot) (?:verify|approve|hold|take)/);
    const after = await call.state(); assert.deepEqual(after.staffItems, before.staffItems); for (const action of Object.values(before.actions)) assert.deepEqual(after.actions[action.key], action.status === "awaitingConfirmation" ? { ...action, status: "canceled" } : action);
    if (sent) assert.match(call.spoken.at(-1)!, mode === "unknown" || mode === "cancelUnknown" ? /can't confirm.*pending review/s : cancel ? /cancellation is confirmed/ : /booking is confirmed/);
    if (mode === "pending") { await play("Yes"); assert.equal(call.writeRequests.length, 0); }
    if (staff && "staffPosts" in f) {
     if (mode === "staffCard") { await play("Please send the message."); assert.equal(f.staffPosts, 0); await play("The message is: FinancialMessageCanary Google Pay failed and I will pay later."); }
     await play("Please send the message."); assert.equal(f.staffPosts, 1); assert.equal(f.recalls.length, 1); assert.match(String(f.recalls[0]!.notes), /FinancialMessageCanary Google Pay failed and I will pay later/); assert.ok(!String(f.recalls[0]!.notes).includes(pan)); assert.equal(call.writeRequests.length, 0);
    }
    assert.ok(models.every(body => !body.includes("FinancialMessageCanary") && !body.includes(pan) && verificationCanaries.every(value => !body.includes(value))));
   } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
   finally { await call?.close(); await f.close(); }
  };
  let next = 0; const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const index = next++, mode = modes[index]; if (!mode) return; try { await run(mode, index); } catch (error) { failures.push(error); } } }));
  for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
  assert.deepEqual(resultValue(await scanPatientDataCanaries(db, [...verificationCanaries, pan, "FinancialMessageCanary"].map((value, index) => ({ label: `financial_evidence_${index}`, value })))), []);
 });
});

test("E2E-343 financial routing rejects quoted, denied or mixed claims and never treats price as payment authority", () => {
 for (const text of questions) assert.ok(financialEvidenceLanguage(text), text);
 for (const text of ["What is the price?", "I am not asking for a refund.", "My friend said 'please send me a payment link'.", "If I get a refund, will I book again?", "Please send me a payment link and cancel my appointment.", "The message is: My Google Pay payment failed."])
  assert.equal(financialEvidenceLanguage(text), undefined, text);
 assert.equal(financialEvidenceLanguage(`The message is: My card number is ${pan}.`), "paymentEvidenceUnavailable");
});
