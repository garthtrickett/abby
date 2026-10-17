import assert from "node:assert/strict";
import test from "node:test";
import { financialBookingFixture } from "../support/financial-booking.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

async function selected(f: Awaited<ReturnType<typeof financialBookingFixture>>) {
  const ref = await f.verify(); resultValue(await f.propose(ref, "financial-selection"));
  const state = await f.state(), pending = state.pendingPresentationId;
  if (pending && state.presentations[pending]?.kind === "notice") {
    resultValue(await f.runtime.startPresentation(f.callId, pending, f.sessionId, verificationNow));
    resultValue(await f.runtime.resolvePresentation(f.callId, pending, "played", f.sessionId, verificationNow));
  }
  return ref;
}
async function consented(f: Awaited<ReturnType<typeof financialBookingFixture>>) {
  const ref = await selected(f); await f.play(); await f.accept(); resultValue(await f.propose(ref, "financial-resume")); return ref;
}
test("actual native booking host requires private played financial consent, then separate clinical confirmation", async () => {
  const f = await financialBookingFixture(); try {
    const ref = await selected(f); const first = await f.state();
    assert.equal(Object.keys(first.actions).length, 0); assert.equal(f.posts, 0); assert.equal(f.rows.size, 1);
    assert.equal(f.pending().inputActive, true); assert.equal(f.pending().readySelection, undefined);
    assert.equal(await f.play(), "pending"); assert.ok(f.texts.join(" ").includes("GBP 50.00")); assert.ok(f.texts.join(" ").includes("financial-recipient@example.invalid"));
    assert.equal(f.pending().readySelection, undefined);
    assert.equal(await f.accept(), "verified"); assert.ok(f.pending().readySelection);
    resultValue(await f.propose(ref, "financial-resume")); assert.equal(f.posts, 0);
    assert.equal(Object.values((await f.state()).actions)[0]?.status, "awaitingConfirmation");
    resultValue(await f.confirm()); resultValue(await f.drain()); assert.equal(f.posts, 1);
    assert.equal(Object.values((await f.state()).actions)[0]?.status, "committed");
    assert.ok(f.proof().financialConsent); assert.equal(f.rows.size, 2);
    const state = JSON.stringify(await f.state()); assert.ok(!state.includes("financial-recipient")); assert.ok(!state.includes("GBP 50.00")); assert.ok(!state.includes("financialConsent"));
  } finally { await f.close(); }
});
test("an unplayed or pre-play queued digit cannot become financial acceptance", async () => {
  const f = await financialBookingFixture(); try {
    await selected(f); const old = f.pending().inputAdmission();
    await f.pending().acceptDigit("1", old);
    assert.equal(await f.pending().acceptDigit("1", old), "pending"); assert.equal(f.pending().readySelection, undefined);
    assert.equal(await f.pending().acceptDigit("1", undefined), "pending"); assert.equal(f.pending().readySelection, undefined);
    await f.play();
    await f.accept(); assert.ok(f.pending().readySelection); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});
test("every bounded financial readback part needs a new post-play digit before final acceptance", async () => {
  const f = await financialBookingFixture(); try {
    await selected(f); const first = f.pending().inputAdmission(); await f.playSegment();
    assert.equal(f.pending().inputAdmission()?.phase, "unplayed"); assert.equal(f.texts.length, 1);
    await f.pending().acceptDigit("1", first); assert.equal(f.texts.length, 1);
    await f.play(); assert.ok(f.texts.length > 2); assert.ok(f.texts.every(s => s.length <= 210));
    assert.equal(f.pending().readySelection, undefined); assert.equal(f.pending().inputAdmission()?.phase, "awaiting");
    await f.accept(); assert.ok(f.pending().readySelection); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});
for (const failure of ["interrupted", "duplicateReceipt"] as const) test(`incomplete multipart financial readback (${failure}) grants no consent`, async () => {
  let n = 0; const id = crypto.randomUUID();
  const f = await financialBookingFixture({ play: async () => ++n > 1 && failure === "interrupted" ? undefined : { presentationRef: id, playedAt: verificationNow } });
  try {
    await selected(f); await f.play(); await f.accept(); assert.equal(n, 2);
    assert.equal(f.pending().readySelection, undefined); assert.equal(f.pending().inputActive, false); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});
for (const played of [false, true]) test(`private decline/failure (played=${played}) cannot create a clinical proposal or receipt`, async () => {
  const f = await financialBookingFixture({ ...(played ? {} : { play: async () => undefined }) }); try {
    const ref = await selected(f); await f.play(); if (played) await f.pending().acceptDigit("2", f.pending().inputAdmission());
    resultValue(await f.propose(ref, "declined-resume")); assert.equal(Object.keys((await f.state()).actions).length, 0); assert.equal(f.posts, 0); assert.equal(f.rows.size, 1);
  } finally { await f.close(); }
});
test("explicit approved no-payment requirement uses the normal clinical confirmation without financial records", async () => {
  const f = await financialBookingFixture({ required: false }); try {
    await selected(f); assert.equal(f.rows.size, 0); assert.equal(f.pending().inputActive, false); assert.equal(f.texts.length, 0);
    resultValue(await f.confirm()); resultValue(await f.drain()); assert.equal(f.posts, 1);
  } finally { await f.close(); }
});
test("unknown financial requirement refuses rather than assuming no deposit", async () => {
  const f = await financialBookingFixture({ quote: () => undefined }); try {
    await selected(f); assert.equal(Object.keys((await f.state()).actions).length, 0); assert.equal(f.rows.size, 0); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});
test("lost prospective intent acknowledgement cannot admit clinical confirmation", async () => {
  const f = await financialBookingFixture({ lostIntent: true }); try {
    await selected(f); assert.equal(f.rows.size, 1); assert.equal(Object.keys((await f.state()).actions).length, 0); assert.equal(f.texts.length, 0); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});
for (const failure of ["loss", "malformed"] as const) test(`financial observation ${failure} preserves actual native booking success`, async () => {
  const f = await financialBookingFixture({ ...(failure === "loss" ? { lostObservation: true } : { observationResponse: () => new Response("{}", { status: 201 }) }) }); try {
    await consented(f); resultValue(await f.confirm()); resultValue(await f.drain());
    assert.equal(f.posts, 1); assert.equal(Object.values((await f.state()).actions)[0]?.status, "committed");
    resultValue(await f.drain()); assert.equal(f.posts, 1); assert.equal(f.rows.size, 2);
  } finally { await f.close(); }
});
test("withdrawn financial authority after acceptance refuses before a native booking POST", async () => {
  const f = await financialBookingFixture(); try {
    await consented(f); resultValue(await f.confirm()); f.denyFinancial(); resultValue(await f.drain()); assert.equal(f.posts, 0); assert.equal(f.rows.size, 1);
  } finally { await f.close(); }
});
for (const awaiting of [false, true]) test(`withdrawn financial readback authority closes private collection without accepting (awaiting=${awaiting})`, async () => {
  const f = await financialBookingFixture(); try {
    await selected(f); if (awaiting) await f.play(); f.denyFinancial();
    assert.equal(await f.accept(), "verified"); assert.equal(f.pending().inputActive, false);
    assert.equal(f.pending().readySelection, undefined); assert.equal(f.posts, 0);
    assert.equal(Object.keys((await f.state()).actions).length, 0);
  } finally { await f.close(); }
});
test("selection corrections invalidate the old financial receipt", async () => {
  const f = await financialBookingFixture(); try {
    const ref = await selected(f); await f.play(); await f.accept(); assert.ok(f.pending().readySelection);
    // A new provider selection cannot reuse the private financial consent.
    f.setEvidence({ offer: { ...f.evidence.offer, offerRef: "changed-offer", startsAt: "2026-10-08T05:00:00.000Z" }, endsAt: "2026-10-08T05:30:00.000Z" });
    resultValue(await f.propose(ref, "changed-selection", "changed-offer"));
    assert.equal(f.pending().readySelection, undefined); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});
test("financial preparation and refresh finish before final native availability", async t => {
  const f = await financialBookingFixture(); try {
    await consented(f); resultValue(await f.confirm());
    const original = f.authority.resolveForSend.bind(f.authority);
    t.mock.method(f.authority, "resolveForSend", async (...args: Parameters<typeof original>) => { const r = await original(...args); f.events.push("finalAvailabilityComplete"); return r; });
    resultValue(await f.drain()); const final = f.events.indexOf("finalAvailabilityComplete"), post = f.events.indexOf("clinical:POST:/v1/individual_appointments");
    assert.ok(final > 0 && post > final); assert.deepEqual(f.events.slice(final + 1, post), []); assert.equal(f.posts, 1);
  } finally { await f.close(); }
});

test("ending the call owner immediately after the exact clinical ACK preserves success and independent financial retention", async t => {
  let retained!: () => void; const observed = new Promise<void>(resolve => { retained = resolve; });
  const f = await financialBookingFixture({ onObservation: retained });
  try {
    await consented(f); resultValue(await f.confirm());
    const write = f.host.write.bind(f.host);
    t.mock.method(f.host, "write", (...[mutation, now, signal, acknowledged]: Parameters<typeof write>) => write(mutation, now, signal, receipt => {
      acknowledged?.(receipt); f.host.dispose();
    }));
    resultValue(await f.drain());
    await Promise.race([observed, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Independent financial retention missing")), 5_000); timer.unref(); })]);
    assert.equal(f.posts, 1); assert.equal(Object.values((await f.state()).actions)[0]?.status, "committed");
    assert.equal(f.financialLife.signal.aborted, false); assert.ok(f.proof().financialConsent);
  } finally { await f.close(); }
});
