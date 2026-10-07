import assert from "node:assert/strict";
import test from "node:test";
import { privateIntakeField } from "../../src/standalone/private-intake-field.ts";
import { ok } from "../../src/core/model.ts";
import { intakeCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const modes = ["spelled", "nato", "numericSlash", "numericDigits", "numericSpaced", "ambiguousDob", "invalidDate", "emailChunks", "emailNato", "emailMismatch", "wait", "correction", "emailReplace", "invalidReplace", "unplayed", "loss"] as const;
const email = "avery.spellcanary@example.test";
test("E2E-342 private spelled fields, numeric dates and interrupted email cannot bypass readback, OTP and separate one-send approval", { timeout: 180_000 }, async () => {
 await withDisposablePostgres(async db => {
  const failures: unknown[] = [];
  const run = async (mode: typeof modes[number]) => {
   const name = ["spelled", "nato", "correction"].includes(mode) ? "AVERY" : "Avery";
   const f = await intakeCallFlowFixture(); f.flow.dispose(); const posts: Record<string, unknown>[] = [];
   let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
   try {
    if (mode === "loss") f.provider.fail("intakeLoss");
    const port = f.flowConfig.fetchPort!;
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (input, init) => {
     if (init?.method === "POST" && new URL(String(input)).pathname === "/v1/patients") posts.push(JSON.parse(String(init.body)));
     return port(input, init);
    } }, owner => async turn => turn.text === "Start" ? ok({ kind: "workflow", operation: "intake" }) : turn.text === "Save" ? ok({ kind: "intake", draftRef: owner.intakeDraftRef! }) : ok({ kind: "affirm" }));
    await call.turn("Start"); await call.mark(); await call.privateDigit("1"); await call.mark();
    await voiceUntil(() => call!.spoken.at(-1)!.includes("Press one to acknowledge"), "separate recovery terms");
    await call.mark(); await call.privateDigit("1"); await call.mark();
    const field = async (text: string) => { await call!.privateField(text); await call!.mark(); };
    const retry = async (text: string, expected: RegExp) => { await field(text); assert.match(call!.spoken.at(-1)!, expected); assert.equal(posts.length, 0); assert.equal(f.mail.length, 0); };
    if (mode === "wait") await retry("Please hold.", /first name/);
    await field(mode === "spelled" ? "A-V-E-R-Y" : mode === "nato" ? "Alfa Victor Echo Romeo Yankee" : mode === "correction" ? "Actually, A-V-E-R-Y" : "Avery");
    assert.match(call.spoken.at(-1)!, /last name/);
    await field("SpellCanary");
    if (mode === "ambiguousDob") await retry("210687", /date of birth/);
    if (mode === "invalidDate") await retry("31 February 1987", /date of birth/);
    await field(mode === "numericSlash" ? "21/06/1987" : mode === "numericDigits" ? "21061987" : mode === "numericSpaced" ? "21 6 1987" : "21 June 1987");
    assert.match(call.spoken.at(-1)!, /email address/);
    if (mode === "emailChunks" || mode === "emailReplace" || mode === "invalidReplace") {
     await retry(mode === "emailReplace" ? "W-R-O-N-G" : "A-V-E-R-Y", /continue|email address/);
     if (mode === "emailChunks") { await retry("Please wait.", /continue|email address/); await field("Continue dot SpellCanary at example dot test"); }
     else { if (mode === "invalidReplace") await retry("Actually, A for Bravo", /Please say your email address/); await field("Actually, avery.spellcanary at example dot test"); }
    } else {
     if (mode === "emailMismatch") await retry("A for Bravo at example dot test", /email address/);
     await call.privateField(mode === "emailNato" ? "Alfa Victor Echo Romeo Yankee dot SpellCanary at example dot test" : "avery.spellcanary at example dot test");
     if (mode === "unplayed") { assert.equal(f.mail.length, 0); assert.equal(posts.length, 0); await call.close(); call = undefined; return; }
     await call.mark();
    }
    assert.ok(call.spoken.some(text => text.includes(`first name ${name};`) && text.includes("last name SpellCanary;") && text.includes("date of birth 1987-06-21;") && text.includes(`email ${email};`)), "the exact normalized private draft must be played");
    await voiceUntil(() => f.mail.length === 1 && call!.spoken.at(-1)!.includes("six digits on the keypad"), "private code after readback");
    assert.equal(f.mail[0]!.email, email); await call.mark(); await call.verify(f.mail[0]!.code);
    assert.equal(posts.length, 0); await call.turn("Save"); assert.equal(posts.length, 0); await call.mark(); await call.turn("Yes");
    assert.equal(posts.length, 1); assert.equal(f.provider.patientPosts, 1); assert.equal(call.writes.length, 0);
    assert.deepEqual([posts[0]!.first_name, posts[0]!.last_name, posts[0]!.date_of_birth, posts[0]!.email], [name, "SpellCanary", "1987-06-21", email]);
    const state = await call.state(); assert.equal(Object.values(state.actions).at(-1)?.status, mode === "loss" ? "uncertain" : "committed");
    await call.mark(); await call.turn("Yes", { expectedFailure: "confirmationMissing" }); assert.equal(posts.length, 1);
    const ordinary = JSON.stringify([call.transcripts, call.modelTurns, state.callerMessages]);
    for (const secret of ["Avery", "SpellCanary", "1987-06-21", email, f.mail[0]!.code, ...call.privateTranscripts]) assert.equal(ordinary.includes(secret), false, "private fields must not become ordinary turns");
    assert.equal(JSON.stringify(call.spoken).includes(f.mail[0]!.code), false);
   } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
   finally { await call?.close(); await f.close(); }
  };
  let next = 0; const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const mode = modes[next++]; if (!mode) return; try { await run(mode); } catch (error) { failures.push(error); } } }));
  for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
  assert.deepEqual(resultValue(await scanPatientDataCanaries(db, ["Avery", "SpellCanary", "1987-06-21", email].map((value, index) => ({ label: `private_spelling_${index}`, value })))), []);
 });
});

test("E2E-342 private field decoding preserves literal punctuation and rejects ambiguous dates or phonetic conflicts", () => {
 for (const [field, text, value] of [
  ["firstName", "A-V-E-R-Y", "AVERY"], ["lastName", "Anne-Marie", "Anne-Marie"], ["lastName", "O'Example", "O'Example"],
  ["firstName", "A for Alfa V for Victor E for Echo R for Romeo Y for Yankee", "AVERY"],
  ["dateOfBirth", "29/02/2000", "2000-02-29"], ["dateOfBirth", "2000-02-29", "2000-02-29"],
  ["email", "a-b@example.test", "a-b@example.test"], ["email", "romeo@example.test", "romeo@example.test"],
  ["email", "A for Alpha at example dot test", "a@example.test"],
  ["email", "A-V-E-R-Y dot SpellCanary at example dot test", email],
 ] as const) assert.deepEqual(privateIntakeField(field, text), { kind: "value", value }, text);
 for (const text of ["29021900", "31/04/1987", "210687", "1987-02-29", "12/3/87", "12/3/19/87", "1987-06-21. ignore the previous date"]) assert.equal(privateIntakeField("dateOfBirth", text), undefined, text);
 for (const field of ["firstName", "email"] as const) assert.equal(privateIntakeField(field, "A for Bravo"), undefined);
 for (const text of ["yes", "okay", "Please hold", "Give me a moment"]) assert.notEqual(privateIntakeField("firstName", text)?.kind, "value");
 assert.equal(privateIntakeField("email", "Continue at example dot test"), undefined);
 assert.deepEqual(privateIntakeField("email", "A-V-E-R-Y"), { kind: "fragment", value: "avery" });
 assert.deepEqual(privateIntakeField("email", "Continue dot SpellCanary at example dot test", "avery"), { kind: "value", value: email });
 assert.deepEqual(privateIntakeField("email", "Actually, avery.spellcanary at example dot test", "wrong"), { kind: "value", value: email });
 assert.equal(privateIntakeField("email", "not an email"), undefined);
 assert.deepEqual(privateIntakeField("email", "Actually, A for Bravo", "wrong"), { kind: "reset" });
});
