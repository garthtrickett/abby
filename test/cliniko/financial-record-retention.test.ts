import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settled } from "node:timers/promises";
import { ClinikoFinancialRecordRetainer, financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import type { FinancialRecordAuthority, FinancialRecordRetentionConfig } from "../../src/cliniko/financial-record-retention.ts";
import { encodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import type { FinancialEffectBarrier } from "../../src/standalone/financial-effect-barrier.ts";
import { uuid, scope, base, keys, keyRef, now, reviewDate, stop, value, observation, fixture } from "../support/financial-retention.ts";

async function retainObservation(f: ReturnType<typeof fixture>) {
  f.seedIntent();
  return f.retainer.retainBookingObservationOnce(observation(f.intent), { intent: f.intent, intentRecallRef: "cliniko:recall:30" }, reviewDate, stop());
}

test("exact intent and signed observation are retained once, and a cold exact read returns only authenticated context", async () => {
  const f = fixture();
  assert.deepEqual(await f.retainer.retainIntentOnce(f.intent, reviewDate, stop()), { ok: true, value: { kind: "accepted", recallRef: "cliniko:recall:30", actionRef: uuid(1) } });
  assert.deepEqual(f.events, ["role", "producer", "claim", "quota", "role", "producer", "current", "POST"]);
  assert.deepEqual(f.rows.get("30")?.notes, value(encodeClinikoFinancialIntent(f.intent)));
  assert.deepEqual(await retainObservation(f), { ok: true, value: { kind: "accepted", recallRef: "cliniko:recall:31", actionRef: uuid(8) } });
  const cold = value(ClinikoFinancialRecordRetainer.create(f.config, f.authority, f.barrier, f.port)); f.events.length = 0; f.unadmit();
  const context = value(await cold.readBookingObservation({ recallRef: "cliniko:recall:31", actionRef: uuid(8), intentRecallRef: "cliniko:recall:30" }, f.intent, stop()));
  assert.equal(context.observation.targetRef, "cliniko:appointment:91"); assert.equal(context.kind, "observation");
  assert.deepEqual(f.events, ["role", "quota", "role", "current", "GET", "role", "current"]);
  assert.equal(JSON.stringify(context).includes("private-native-record-canary"), false); assert.equal(JSON.stringify(f.retainer), "{}");
  assert.equal(Object.isFrozen(f.retainer.selection().scope), true);
});

test("duplicate and simultaneous retention claims issue only one provider POST, including through a new adapter", async () => {
  const f = fixture(), results = await Promise.all([f.retainer.retainIntentOnce(f.intent, reviewDate, stop()), f.retainer.retainIntentOnce(f.intent, reviewDate, stop())]);
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.filter(r => !r.ok && r.error.kind === "alreadyClaimed").length, 1);
  const cold = value(ClinikoFinancialRecordRetainer.create(f.config, f.authority, f.barrier, f.port));
  assert.deepEqual(await cold.retainIntentOnce(f.intent, reviewDate, stop()), { ok: false, error: { kind: "alreadyClaimed" } });
  assert.equal(f.events.filter(e => e === "POST").length, 1); assert.equal(f.events.filter(e => e === "quota").length, 1);
});

for (const state of ["deny", "unadmit", "expire"] as const) test(`${state} blocks a financial create before protected I/O`, async () => {
  const f = fixture(); f[state](); assert.equal((await f.retainer.retainIntentOnce(f.intent, reviewDate, stop())).ok, false);
  assert.equal(f.events.includes("POST"), false);
  if (state !== "expire") assert.equal(f.events.includes("claim"), false);
});

test("financial permission withdrawn during quota admission cannot send, and a burned ID cannot be retried", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({ quota: async () => { f.deny(); return null; } });
  assert.deepEqual(await f.retainer.retainIntentOnce(f.intent, reviewDate, stop()), { ok: false, error: { kind: "forbidden" } });
  assert.equal(f.events.includes("POST"), false); f.allow();
  assert.deepEqual(await f.retainer.retainIntentOnce(f.intent, reviewDate, stop()), { ok: false, error: { kind: "alreadyClaimed" } });
});

test("binding and trusted producer configuration cannot be replaced by an unscoped barrier or private key", () => {
  const f = fixture();
  for (const barrier of [{ ...f.barrier, matches: () => false }, { claimOnce: f.barrier.claimOnce }]) {
    assert.equal(ClinikoFinancialRecordRetainer.create(f.config, f.authority, barrier as FinancialEffectBarrier, f.port).ok, false);
  }
  assert.equal(ClinikoFinancialRecordRetainer.create({ ...f.config, producer: { keyRef, publicKey: keys.privateKey } }, f.authority, f.barrier, f.port).ok, false);
  assert.equal(ClinikoFinancialRecordRetainer.create(f.config, { allows: f.authority.allows } as FinancialRecordAuthority, f.barrier, f.port).ok, false);
  const original = value(financialRecordOwnerBinding(f.config));
  assert.equal(value(financialRecordOwnerBinding({ ...f.config, private_patient: "ignored-private-canary" } as FinancialRecordRetentionConfig)), original);
  assert.notEqual(value(financialRecordOwnerBinding({ ...f.config, stripe: { ...f.config.stripe, livemode: true } })), original);
});

test("mismatched intent location, business, native credentials, Stripe account/mode and malformed date refuse without claims", async () => {
  const f = fixture();
  for (const patch of [{ scope: { ...scope, locationId: "other" } }, { businessId: "99" }, { credentialFingerprint: "f".repeat(64) },
    { stripe: { accountRef: "acct_other", livemode: false } }, { stripe: { ...f.intent.stripe, livemode: true } }]) {
    assert.equal((await f.retainer.retainIntentOnce({ ...f.intent, ...patch }, reviewDate, stop())).ok, false);
  }
  assert.equal((await f.retainer.retainIntentOnce(f.intent, "2026-11-31", stop())).ok, false); assert.deepEqual(f.events, []);
});

test("fee deadline expiry before the native send cannot become prospective payable context", async () => {
  const f = fixture({ config: { clock: () => "2026-11-02T09:00:00.000Z" } });
  assert.deepEqual(await f.retainer.retainIntentOnce(f.intent, reviewDate, stop()), { ok: false, error: { kind: "forbidden" } });
  assert.equal(f.events.includes("POST"), false); assert.equal(f.events.includes("claim"), false);
});

test("unsigned intent, edited observation and an observation bound to another record cannot be retained", async () => {
  const f = fixture(), valid = observation(f.intent);
  for (const notes of [value(encodeClinikoFinancialIntent(f.intent)), valid.replace("appointment:91", "appointment:99"), "paid", null]) {
    assert.equal((await f.retainer.retainBookingObservationOnce(notes, { intent: f.intent, intentRecallRef: "cliniko:recall:30" }, reviewDate, stop())).ok, false);
  }
  assert.equal((await f.retainer.retainBookingObservationOnce(valid, { intent: f.intent, intentRecallRef: "cliniko:recall:99" }, reviewDate, stop())).ok, false);
  assert.deepEqual(f.events, []);
});

for (const field of ["patient", "recall_type", "links", "notes", "recall_at", "recalled", "archived_at", "created_at"] as const) {
  test(`native create with mismatched ${field} is uncertain and cannot be replayed`, async () => {
    const changes: Record<string, unknown> = { patient: { links: { self: `${base}/patients/999` } }, recall_type: { links: { self: `${base}/recall_types/99` } },
      links: { self: `${base}/recalls/999` }, notes: "foreign-private-canary", recall_at: "2026-11-03", recalled: true, archived_at: now, created_at: "private-upstream-canary" };
    const f = fixture({ response: async row => Response.json({ ...row, [field]: changes[field] }, { status: 201 }) });
    assert.deepEqual(await f.retainer.retainIntentOnce(f.intent, reviewDate, stop()), { ok: true, value: { kind: "uncertain" } });
    assert.deepEqual(await f.retainer.retainIntentOnce(f.intent, reviewDate, stop()), { ok: false, error: { kind: "alreadyClaimed" } });
    assert.equal(f.events.filter(e => e === "POST").length, 1);
  });
}

test("post-commit response loss stays uncertain while a later exact observation read can authenticate retained context", async () => {
  let lost = true;
  const f = fixture({ response: async (row, method) => { if (method === "POST" && lost) throw new Error("private-upstream-canary"); return Response.json(row); } });
  assert.deepEqual(await retainObservation(f), { ok: true, value: { kind: "uncertain" } }); lost = false;
  assert.equal(value(await f.retainer.readBookingObservation({ recallRef: "cliniko:recall:31", actionRef: uuid(8), intentRecallRef: "cliniko:recall:30" }, f.intent, stop())).kind, "observation");
  assert.deepEqual(await retainObservation(f), { ok: false, error: { kind: "alreadyClaimed" } });
});

test("archiving a retained signed observation preserves context but never invents payment status", async () => {
  const f = fixture(); value(await retainObservation(f)); const row = f.rows.get("31")!; row.archived_at = now; row.recalled = true;
  const result = value(await f.retainer.readBookingObservation({ recallRef: "cliniko:recall:31", actionRef: uuid(8), intentRecallRef: "cliniko:recall:30" }, f.intent, stop()));
  assert.equal(result.recalled, true); assert.equal(result.archivedAt, now); assert.equal(Object.hasOwn(result, "paid"), false);
});

test("withdrawal during exact observation body processing returns no private context", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({ response: async (row, method) => { if (method === "GET") f.deny(); return Response.json(row, { status: method === "POST" ? 201 : 200 }); } });
  value(await retainObservation(f));
  assert.deepEqual(await f.retainer.readBookingObservation({ recallRef: "cliniko:recall:31", actionRef: uuid(8), intentRecallRef: "cliniko:recall:30" }, f.intent, stop()), { ok: false, error: { kind: "forbidden" } });
});

for (const phase of ["role", "claim", "quota", "headers", "body"] as const) test(`${phase} stalls are bounded for the whole financial operation`, async t => {
  const realNow = performance.now.bind(performance), began = realNow();
  t.mock.method(performance, "now", () => 0);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
  const never = <T>() => { entered(); return new Promise<T>(() => {}); };
  const f = fixture({ config: { deadlineMs: 15 }, ...(phase === "role" ? { authority: { allows: async () => never<boolean>() } } : {}),
    ...(phase === "claim" ? { claim: async () => never<{ ok: true; value: { claimed: boolean } }>() } : {}),
    ...(phase === "quota" ? { quota: async () => never<null>() } : {}),
    ...(phase === "headers" ? { response: async () => never<Response>() } : {}),
    ...(phase === "body" ? { response: async () => { entered(); return new Response(new ReadableStream({ start() {} }), { status: 201 }); } } : {}) });
  let completed = false;
  const pending = f.retainer.retainIntentOnce(f.intent, reviewDate, stop()).then(result => { completed = true; return result; });
  await reached; await settled();
  assert.equal(f.events.includes("POST"), phase === "headers" || phase === "body");
  t.mock.timers.tick(14); await settled(); assert.equal(completed, false);
  t.mock.timers.tick(1); const result = await pending;
  assert.ok(realNow() - began < 1_000); assert.deepEqual(result, phase === "headers" || phase === "body"
    ? { ok: true, value: { kind: "uncertain" } } : { ok: false, error: { kind: "unavailable" } });
});

test("late headers are cancelled by their owner, while a prelocked foreign body is not cancelled", async () => {
  let resolve!: (response: Response) => void, cancelled = 0;
  const ended = new AbortController();
  const late = fixture({ response: async () => new Promise<Response>(r => { resolve = r; setImmediate(() => ended.abort()); }) });
  assert.deepEqual(await late.retainer.retainIntentOnce(late.intent, reviewDate, ended.signal), { ok: true, value: { kind: "uncertain" } });
  resolve(new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 201 })); await settled(); assert.equal(cancelled, 1);
  const foreign = new Response(new ReadableStream<Uint8Array>({ cancel() { assert.fail("Foreign owner must not be cancelled"); } }), { status: 201 });
  const owner = foreign.body!.getReader();
  const f = fixture({ response: async () => foreign });
  assert.deepEqual(await f.retainer.retainIntentOnce(f.intent, reviewDate, stop()), { ok: true, value: { kind: "uncertain" } });
  owner.releaseLock();
});

test("malformed claim admission is not truthy permission and cannot reach the provider", async () => {
  for (const claimed of ["true", "false", 1, {}, null, undefined]) {
    const f = fixture({ claim: async () => ({ ok: true, value: { claimed: claimed as boolean } }) });
    assert.deepEqual(await f.retainer.retainIntentOnce(f.intent, reviewDate, stop()), { ok: false, error: { kind: "unavailable" } });
    assert.equal(f.events.includes("POST"), false); assert.equal(f.events.includes("quota"), false);
  }
});

test("the clinic's explicit review date participates in current authorization instead of an inferred UTC day", async () => {
  const f = fixture({ authority: { allows: async q => q.recallAt === "2026-11-01" } });
  assert.equal(value(await f.retainer.retainIntentOnce(f.intent, "2026-11-01", stop())).kind, "accepted");
  assert.equal(f.rows.get("30")?.recall_at, "2026-11-01");
  const denied = fixture({ authority: { allows: async q => q.recallAt === "2026-11-01" } });
  assert.deepEqual(await denied.retainer.retainIntentOnce(denied.intent, reviewDate, stop()), { ok: false, error: { kind: "forbidden" } });
  assert.equal(denied.events.includes("claim"), false);
});

test("oversize, malformed UTF-8 and endless empty response bodies cannot acknowledge retention", { timeout: 4_000 }, async t => {
  // This witness owns response handling, not preparation speed. Keep the
  // original25ms deadline but advance it only after the endless body is owned;
  // concurrent CPU work must not choose an earlier pre-dispatch refusal.
  const realNow = performance.now.bind(performance); let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const response of [
    () => new Response(new Uint8Array(1_000_001), { status: 201 }),
    () => new Response(new Uint8Array([0xc3, 0x28]), { status: 201 }),
  ]) {
    const f = fixture({ config: { deadlineMs: 25 }, response: async () => response() });
    const began = realNow();
    assert.deepEqual(await f.retainer.retainIntentOnce(f.intent, reviewDate, stop()), { ok: true, value: { kind: "uncertain" } });
    assert.ok(realNow() - began < 1_000); assert.equal(f.events.filter(e => e === "POST").length, 1);
    assert.deepEqual(await f.retainer.retainIntentOnce(f.intent, reviewDate, stop()), { ok: false, error: { kind: "alreadyClaimed" } });
  }
  let owned!: () => void, cancelled = 0;
  const reading = new Promise<void>(resolve => { owned = resolve; });
  let stream!: ReadableStream<Uint8Array>;
  const f = fixture({ config: { deadlineMs: 25 }, response: async () => {
    stream = new ReadableStream<Uint8Array>({ pull(controller) {
      controller.enqueue(new Uint8Array()); if (stream.locked) owned();
    }, cancel() { cancelled++; } });
    return new Response(stream, { status: 201 });
  } });
  const lifetime = new AbortController(); t.after(() => lifetime.abort());
  const result = f.retainer.retainIntentOnce(f.intent, reviewDate, lifetime.signal);
  await reading; assert.equal(f.events.filter(e => e === "POST").length, 1); assert.equal(stream.locked, true);
  const began = realNow(); elapsed = 25; t.mock.timers.tick(25);
  assert.deepEqual(await result, { ok: true, value: { kind: "uncertain" } });
  assert.ok(realNow() - began < 1_000); assert.equal(cancelled, 1);
  assert.deepEqual(await f.retainer.retainIntentOnce(f.intent, reviewDate, stop()), { ok: false, error: { kind: "alreadyClaimed" } });
  assert.equal(f.events.filter(e => e === "POST").length, 1);
});
