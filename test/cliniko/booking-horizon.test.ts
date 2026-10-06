import assert from "node:assert/strict";
import test from "node:test";
import { TextReception } from "../../src/reference/text-reception.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { bookingHorizonUnavailable } from "../../src/core/booking-horizon.ts";

test("E2E-321 approval expiry during a held public read uses fresh owner time rather than caller command time", { timeout: 15_000 }, async () => {
  const f = await bookingCallFlowFixture();
  let release: () => void = () => undefined, entered: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { entered = resolve; });
  let pending: ReturnType<TextReception["readBookingHorizon"]> | undefined;
  try {
    await f.replacePolicy({ effectiveUntil: "2026-10-04T06:00:00.500Z" });
    const original = f.flow.readBookingHorizon.bind(f.flow);
    f.flow.readBookingHorizon = async query => { const value = await original(query); assert.equal(value.ok, true); entered(); await gate; return value; };
    const reception = new TextReception(f.ledger, f.policies, f.flow, undefined, undefined, undefined, undefined, f.flowConfig.clock);
    const before = await f.state(), mail = f.mail.length, traffic = f.allTraffic.length;
    pending = reception.readBookingHorizon(f.scope, f.turn("held-horizon", "How far ahead can I book?"));
    await held; f.setTime("2026-10-04T06:00:01.000Z"); release();
    const state = resultValue(await pending); assert.equal(state.callerMessages.at(-1), bookingHorizonUnavailable);
    assert.deepEqual(state.actions, before.actions); assert.deepEqual(state.staffItems, before.staffItems);
    assert.equal(f.mail.length, mail); assert.equal(f.allTraffic.length, traffic);
  } finally { release(); await pending; f.flow.dispose(); await f.close(); }
});

test("E2E-321 cancellation of a held horizon query cannot publish a late public answer", { timeout: 15_000 }, async () => {
  const f = await bookingCallFlowFixture();
  let release: () => void = () => undefined, entered: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { entered = resolve; });
  let pending: ReturnType<TextReception["readBookingHorizon"]> | undefined;
  try {
    const original = f.flow.readBookingHorizon.bind(f.flow);
    f.flow.readBookingHorizon = async query => { const value = await original(query); entered(); await gate; return value; };
    const reception = new TextReception(f.ledger, f.policies, f.flow, undefined, undefined, undefined, undefined, f.flowConfig.clock);
    const before = await f.state(), lifetime = new AbortController();
    pending = reception.readBookingHorizon(f.scope, f.turn("aborted-horizon", "How far ahead can I book?"), undefined, lifetime.signal);
    await held; lifetime.abort(); assert.equal((await pending).ok, false); release();
    assert.deepEqual(await f.state(), before);
  } finally { release(); await pending; f.flow.dispose(); await f.close(); }
});
