import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { AdministrativeMemoAuthentication, administrativeMemoActionRef, decodeAdministrativeMemo } from "../../src/cliniko/administrative-memo.ts";
import { administrativeMemoRecordBinding } from "../../src/cliniko/administrative-memo-records.ts";
import type { AdministrativeMemoConfig, AdministrativeMemoQuery } from "../../src/cliniko/administrative-memo-records.ts";
import type { BookingMemoOutcome } from "../../src/standalone/cliniko-booking-memo.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { ok } from "../../src/core/model.ts";
import { commandProgress } from "../../src/reference/command-progress.ts";
import { standaloneBookingFixture } from "../support/standalone-booking.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";
import { value } from "../support/outbound-records.ts";

async function fixture(options: { lostRecall?: boolean; lostBooking?: boolean; deadlineMs?: number; wrongBudget?: boolean;
  mode?: "lostStored" | "lostUnstored" | "nonexact" | "lateDisclosure" } = {}) {
  const key = randomBytes(32), auth = new AdministrativeMemoAuthentication(key), signalOwner = new AbortController();
  const budget = new ClinikoReadBudget(180), outcomes: BookingMemoOutcome[] = [], queries: AdministrativeMemoQuery[] = [];
  const posts: Record<string, unknown>[] = [], rows: Record<string, unknown>[] = [], consumed = new Set<string>();
  let finish!: () => void; const memoSettled = new Promise<void>(resolve => { finish = resolve; });
  const state = { allowed: true, producer: true, current: true,
    hold: undefined as undefined | Promise<void>, observer: undefined as undefined | ((outcome: BookingMemoOutcome) => void) };
  const f = await standaloneBookingFixture({ rateBudget: budget,
    ...(options.lostRecall ? { lostRecall: true } : {}), ...(options.lostBooking ? { lostBooking: true } : {}),
    fetchAround: base => async (url, init) => {
      if (!String(url).includes("/communications")) return base(url, init);
      assert.equal(String(url), "https://api.au5.cliniko.com/v1/communications"); assert.equal(init?.method, "POST"); assert.equal(init.redirect, "error");
      const body = JSON.parse(String(init.body)); posts.push(body);
      const memo = value(decodeAdministrativeMemo(body.content)); assert.equal(auth.verify(memo), true);
      const row = { ...body, id: "701", created_at: verificationNow, updated_at: verificationNow, archived_at: null,
        patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${body.patient_id}` } }, links: { self: "https://api.au5.cliniko.com/v1/communications/701" } };
      if (options.mode !== "lostUnstored") rows.push(row);
      if (options.mode === "lostStored" || options.mode === "lostUnstored") throw Error("Synthetic memo acknowledgement lost");
      if (options.mode === "nonexact") return Response.json({ ...row, confidential: false }, { status: 201 });
      if (options.mode === "lateDisclosure") return new Response(new ReadableStream({ pull(c) {
        state.current = false; c.enqueue(new TextEncoder().encode(JSON.stringify(row))); c.close();
      } }, { highWaterMark: 0 }), { status: 201 });
      return Response.json(row, { status: 201 });
    },
    memoFor: (clinical, port) => {
      const native: AdministrativeMemoConfig = { scope: clinical.scope, businessId: clinical.businessId, apiKey: clinical.apiKey, contactEmail: clinical.contactEmail,
        authorRef: "clinic-approved-admin-memo", policy: { version: "admin-actions-v1", digest: "a".repeat(64) },
        rateBudget: options.wrongBudget ? new ClinikoReadBudget(180) : clinical.rateBudget, clock: () => verificationNow, deadlineMs: options.deadlineMs ?? 5000 };
      const owner = administrativeMemoRecordBinding(native, auth)!;
      return { native, authentication: auth, memoSignal: signalOwner.signal, fetchPort: port,
        authority: { allows: async q => { queries.push(q); await state.hold; return state.allowed; }, current: () => state.current,
          producerAdmitted: async q => state.producer && q.memo?.patientId === verificationCanaries[2] },
        barrier: { matches: (s, binding) => JSON.stringify(s) === JSON.stringify(native.scope) && binding === owner,
          claimOnce: async ref => { const claimed = !consumed.has(ref); consumed.add(ref); return ok({ claimed }); } },
        observeOutcome: outcome => { outcomes.push(outcome); try { state.observer?.(outcome); } finally { finish(); } } };
    } });
  async function prepare() { const ref = await f.verify(); assert.ok((await f.propose(ref)).ok); assert.ok((await f.confirm()).ok); }
  return { ...f, memoState: state, outcomes, postsMemo: posts, rowsMemo: rows, consumed, queries, prepare, signalOwner, budget, key, memoSettled,
    drainClinical: f.drain,
    drain: async () => { const result = await f.drain(); if (Object.values((await f.state()).actions).some(a => a.status === "committed")) await memoSettled; return result; },
    close: async () => { signalOwner.abort(); await f.close(); } };
}

test("actual verified booking, played SAM and native201 produce a separately approved exact-subject administrative memo", async t => {
  const f = await fixture(); t.after(f.close); await f.prepare(); assert.equal(f.postsMemo.length, 0);
  await f.drain(); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
  assert.equal(f.traffic.filter(x => x === "POST /v1/individual_appointments").length, 1); assert.equal(f.recalls.length, 1);
  assert.equal(f.postsMemo.length, 1); assert.equal(f.outcomes[0]!.kind, "accepted");
  const memo = value(decodeAdministrativeMemo(f.postsMemo[0]!.content));
  assert.equal(memo.patientId, verificationCanaries[2]); assert.equal(memo.outcome.appointmentRef, "cliniko:appointment:91");
  assert.equal(memo.outcome.startsAt, new Date(f.evidence.offer.startsAt).toISOString()); assert.equal(memo.outcome.endsAt, new Date(f.evidence.endsAt).toISOString());
  assert.equal(memo.direction, "inbound"); assert.equal(memo.actionRef, administrativeMemoActionRef(memo.sourceActionRef)); assert.equal(f.consumed.size, 1);
  const reply = JSON.stringify(commandProgress(await f.state(), "memo-result"));
  for (const privateValue of [memo.patientId, memo.authentication, ...verificationCanaries, f.mail[0]!.code]) assert.equal(reply.includes(privateValue), false);
  await f.drain(); assert.equal(f.postsMemo.length, 1); assert.equal(f.outcomes.length, 1);
});

for (const denied of ["allowed", "producer", "current"] as const)
test(`memo ${denied} denial after native booking cannot erase or repeat clinical success`, async t => {
  const f = await fixture(); t.after(f.close); await f.prepare();
  f.setOnBooking(async () => { f.memoState[denied] = false; });
  await f.drain(); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
  assert.equal(f.postsMemo.length, 0); assert.equal(f.outcomes[0]!.kind, "unavailable");
  assert.equal(f.traffic.filter(x => x === "POST /v1/individual_appointments").length, 1); await f.drain(); assert.equal(f.postsMemo.length, 0);
});

test("shared physical native180 may refuse the memo after clinical acknowledgement without changing the known booking", async t => {
  const f = await fixture(); t.after(f.close); await f.prepare();
  f.setOnBooking(async () => { for (let n = 0; n < 180; n++) if (f.budget.claim() !== null) break; });
  await f.drain(); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
  assert.equal(f.postsMemo.length, 0); assert.equal(f.consumed.size, 1); assert.equal(f.outcomes[0]!.kind, "unavailable");
});

for (const mode of ["lostStored", "lostUnstored", "nonexact"] as const)
test(`${mode} memo result stays separate from the exact clinical receipt and cannot trigger replay`, async t => {
  const f = await fixture({ mode }); t.after(f.close); await f.prepare(); await f.drain();
  assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed"); assert.equal(f.postsMemo.length, 1); assert.equal(f.outcomes[0]!.kind, "uncertain");
  await f.drain(); assert.equal(f.postsMemo.length, 1); assert.equal(f.traffic.filter(x => x === "POST /v1/individual_appointments").length, 1);
});

test("a known memo acknowledgement can withhold disclosure without relabelling the known clinical result", async t => {
  const f = await fixture({ mode: "lateDisclosure" }); t.after(f.close); await f.prepare(); await f.drain();
  assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed"); assert.equal(f.postsMemo.length, 1);
  assert.deepEqual(f.outcomes, [{ kind: "acceptedWithheld" }]);
});

test("a separately aborted memo lifetime and an observer exception cannot erase a native booking", async t => {
  for (const abort of [false, true]) {
    const f = await fixture(); t.after(f.close); await f.prepare();
    if (abort) f.signalOwner.abort(); else f.memoState.observer = () => { throw Error("Synthetic observer unavailable"); };
    await f.drain(); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
    assert.equal(f.postsMemo.length, abort ? 0 : 1); assert.equal(f.outcomes[0]!.kind, abort ? "unavailable" : "accepted");
  }
});

test("clinical owner disposal after its exact acknowledgement cannot erase historical memo provenance or repeat booking", async t => {
  const f = await fixture(); t.after(f.close); await f.prepare();
  const write = f.host.write.bind(f.host);
  t.mock.method(f.host, "write", (...[mutation, now, signal, accepted]: Parameters<typeof write>) => write(mutation, now, signal, receipt => {
    accepted?.(receipt); f.host.dispose();
  }));
  await f.drain(); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
  assert.equal(f.postsMemo.length, 1); assert.equal(f.outcomes[0]!.kind, "accepted");
  await f.drain(); assert.equal(f.postsMemo.length, 1); assert.equal(f.traffic.filter(x => x === "POST /v1/individual_appointments").length, 1);
});

test("held memo permission expires under its own deadline and cannot POST later or cancel an acknowledged booking", async t => {
  const f = await fixture({ deadlineMs: 30 }); t.after(f.close); let release!: () => void;
  f.memoState.hold = new Promise<void>(resolve => { release = resolve; }); await f.prepare(); await f.drain();
  assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed"); assert.equal(f.postsMemo.length, 0);
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.postsMemo.length, 0);
});

test("memo permission wait cannot delay the caller's known booking result", { timeout: 10000 }, async t => {
  const f = await fixture(); t.after(f.close); let release!: () => void;
  f.memoState.hold = new Promise<void>(resolve => { release = resolve; }); await f.prepare();
  try {
    await f.drainClinical(); assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
    assert.equal(f.outcomes.length, 0, "the clinical result must return while memo permission is still pending");
    assert.equal(f.postsMemo.length, 0); release(); await f.memoSettled;
    assert.equal(f.outcomes[0]!.kind, "accepted"); assert.equal(f.postsMemo.length, 1);
  } finally { release(); }
});

for (const unknown of ["review", "booking"] as const)
test(`unknown ${unknown} result cannot mint a confirmed-outcome memo`, async t => {
  const f = await fixture(unknown === "review" ? { lostRecall: true } : { lostBooking: true }); t.after(f.close); await f.prepare(); await f.drain();
  assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed"); assert.equal(f.postsMemo.length, 0); assert.equal(f.consumed.size, 0);
});

test("a separate memo budget cannot be mounted beside the clinical writer's actual physical budget", async () => {
  await assert.rejects(fixture({ wrongBudget: true }), /Invalid administrative booking memo selection/);
});
