import assert from "node:assert/strict";
import test from "node:test";
import { RegisteredEmailChallenge } from "../../src/shared/registered-email-challenge.ts";

type Identity = Readonly<{ kind: "guardian" | "patient"; recordRef: string; registeredEmail: string }>;
type Context = "appointments.book" | "appointments.cancel";
const scope = { tenantId: "email-challenge-tenant", clinicId: "clinic", locationId: "location" };
function fixture(kind: Identity["kind"] = "guardian", ceiling?: number) {
  const state = { current: { kind, recordRef: "identity-1", registeredEmail: "registered@example.test" } as Identity,
    now: 1_000, issueAllowed: true, answerAllowed: true, accepted: true, reads: 0,
    beforeRead: undefined as (() => Promise<void>) | undefined };
  const mail: { email: string; code: string }[] = [], reservations: string[] = [];
  const challenge = new RegisteredEmailChallenge<Identity, Context>({ scope, contexts: ["appointments.book", "appointments.cancel"], clock: () => state.now,
    ...(ceiling === undefined ? {} : { expiryCeiling: () => ceiling }),
    current: async () => { state.reads++; await state.beforeRead?.(); return state.current; },
    budget: { reserve: async (bound, kind) => { assert.deepEqual(bound, scope); reservations.push(kind); return kind === "issue" ? state.issueAllowed : state.answerAllowed; } },
    delivery: { send: async (email, code) => { mail.push({ email, code }); return state.accepted; } },
  });
  return { state, mail, reservations, challenge };
}
const signal = () => new AbortController().signal;

test("registered email challenge retains identity kind and consumes one exact-context opaque grant", async () => {
  const f = fixture(); await Promise.all([f.challenge.start("appointments.book"), f.challenge.start("appointments.book")]);
  assert.equal(f.mail.length, 1); assert.equal(f.mail[0]!.email, "registered@example.test"); assert.match(f.mail[0]!.code, /^[0-9]{6}$/);
  const answered = await f.challenge.answer(f.mail[0]!.code); assert.equal(answered.ok, true); if (!answered.ok) return;
  const accepts = (snapshot: Identity) => snapshot.kind === "guardian" && snapshot.recordRef === "identity-1";
  assert.equal((await f.challenge.consume({ token: answered.value, context: "appointments.cancel", accepts, signal: signal() })).ok, false);
  assert.equal((await f.challenge.consume({ token: answered.value, context: "appointments.book", accepts: () => false, signal: signal() })).ok, false);
  const consumed = await f.challenge.consume({ token: answered.value, context: "appointments.book", accepts, signal: signal() });
  assert.equal(consumed.ok, true); if (!consumed.ok) return;
  assert.equal(consumed.value.snapshot.kind, "guardian"); assert.equal(consumed.value.expiresAt, 301_000);
  assert.equal((await f.challenge.consume({ token: answered.value, context: "appointments.book", accepts, signal: signal() })).ok, false);
  assert.equal(await f.challenge.revalidate("appointments.book", accepts, signal()), true);
  assert.deepEqual(f.reservations, ["issue", "answer"]); assert.equal(f.state.reads, 4);
});

test("registered email grants cannot move between guardian and patient owners even with the same mailbox", async () => {
  const guardian = fixture("guardian"), patient = fixture("patient");
  await guardian.challenge.start("appointments.book"); await patient.challenge.start("appointments.book");
  const g = await guardian.challenge.answer(guardian.mail[0]!.code), p = await patient.challenge.answer(patient.mail[0]!.code);
  assert.ok(g.ok && p.ok); if (!g.ok || !p.ok) return;
  assert.equal((await patient.challenge.consume({ token: g.value, context: "appointments.book", accepts: () => true, signal: signal() })).ok, false);
  assert.equal((await guardian.challenge.consume({ token: p.value, context: "appointments.book", accepts: () => true, signal: signal() })).ok, false);
  const own = await guardian.challenge.consume({ token: g.value, context: "appointments.book", accepts: () => true, signal: signal() });
  assert.equal(own.ok && own.value.snapshot.kind, "guardian");
});

test("registered email challenge keeps three answer attempts and aggregate issue/answer budget", async () => {
  const f = fixture(); await f.challenge.start("appointments.book"); const correct = f.mail[0]!.code, wrong = correct === "000000" ? "111111" : "000000";
  for (let n = 0; n < 3; n++) assert.equal((await f.challenge.answer(wrong)).ok, false);
  assert.equal((await f.challenge.answer(correct)).ok, false); assert.deepEqual(f.reservations, ["issue", "answer", "answer", "answer"]);
  assert.equal(f.state.reads, 1);
  const deniedIssue = fixture(); deniedIssue.state.issueAllowed = false; await deniedIssue.challenge.start("appointments.book");
  assert.equal(deniedIssue.mail.length, 0); assert.equal(deniedIssue.state.reads, 0);
  const deniedAnswer = fixture(); await deniedAnswer.challenge.start("appointments.book"); deniedAnswer.state.answerAllowed = false;
  assert.equal((await deniedAnswer.challenge.answer(deniedAnswer.mail[0]!.code)).ok, false); assert.equal(deniedAnswer.state.reads, 1);
});

test("registered email verification refuses a changed identity or channel rather than following a mutable snapshot", async () => {
  for (const change of [{ recordRef: "identity-2" }, { registeredEmail: "different@example.test" }, { kind: "patient" as const }]) {
    const f = fixture(); await f.challenge.start("appointments.book"); Object.assign(f.state.current, change);
    assert.equal((await f.challenge.answer(f.mail[0]!.code)).ok, false); assert.equal(f.mail.length, 1);
  }
});

test("registered email proof expiry is capped at five minutes and may be shortened by guardian approval expiry", async () => {
  const short = fixture("guardian", 2_000); await short.challenge.start("appointments.book");
  const answered = await short.challenge.answer(short.mail[0]!.code); assert.equal(answered.ok, true); if (!answered.ok) return;
  const grant = await short.challenge.consume({ token: answered.value, context: "appointments.book", accepts: () => true, signal: signal() });
  assert.equal(grant.ok && grant.value.expiresAt, 2_000); short.state.now = 2_000;
  assert.equal(await short.challenge.revalidate("appointments.book", () => true, signal()), false);
  const long = fixture("guardian", 999_999); await long.challenge.start("appointments.book"); long.state.now = 301_000;
  assert.equal((await long.challenge.answer(long.mail[0]!.code)).ok, false);
});

test("registered email failed current revalidation invalidates the attestation and cannot revive by restoring old values", async () => {
  const f = fixture(); await f.challenge.start("appointments.book"); const answer = await f.challenge.answer(f.mail[0]!.code); assert.equal(answer.ok, true); if (!answer.ok) return;
  assert.equal((await f.challenge.consume({ token: answer.value, context: "appointments.book", accepts: () => true, signal: signal() })).ok, true);
  f.state.current = { ...f.state.current, recordRef: "withdrawn-version" };
  assert.equal(await f.challenge.revalidate("appointments.book", () => true, signal()), false);
  f.state.current = { ...f.state.current, recordRef: "identity-1" };
  assert.equal(await f.challenge.revalidate("appointments.book", () => true, signal()), false);
});

test("registered email close bounds a non-cooperative identity read and prevents a late message", async () => {
  const f = fixture(); let entered: () => void = () => undefined, release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
  f.state.beforeRead = async () => { entered(); await resume; };
  const starting = f.challenge.start("appointments.book"); await held; f.challenge.close(); await starting;
  release(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.mail.length, 0);
  assert.equal((await f.challenge.answer("000000")).ok, false);
});

test("registered email cancellation while consuming burns the one-use grant and rejects late completion", async () => {
  const f = fixture(); await f.challenge.start("appointments.book"); const answered = await f.challenge.answer(f.mail[0]!.code); assert.equal(answered.ok, true); if (!answered.ok) return;
  let entered: () => void = () => undefined, release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
  f.state.beforeRead = async () => { entered(); await resume; };
  const controller = new AbortController(), consuming = f.challenge.consume({ token: answered.value, context: "appointments.book", accepts: () => true, signal: controller.signal });
  await held; controller.abort(); assert.equal((await consuming).ok, false); release(); await new Promise<void>(resolve => setImmediate(resolve));
  f.state.beforeRead = undefined;
  assert.equal((await f.challenge.consume({ token: answered.value, context: "appointments.book", accepts: () => true, signal: signal() })).ok, false);
  assert.equal(await f.challenge.revalidate("appointments.book", () => true, signal()), false);
});
