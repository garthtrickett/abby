import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { distinctFromClock, drawDistinctCode, assertDirectSqlVerificationCanaryContext, installDirectSqlVerificationCanaries, installClinicalVerificationCanaries, installResendVerificationCanaries, installStagedVerificationCanaries } from "../support/verification-code-canary.ts";

test("numeric verification canaries reject every real timestamp substring across decimal rollovers", () => {
  for (const sinceMs of [1792470200000, 1792470990000, 1792479990000]) {
    const window = { sinceMs, throughMs: sinceMs + 660000 };
    const candidates = [0, 100000, 179247, 999999, 818181, 707070, 234567];
    let next = 0;
    const safe = drawDistinctCode(() => candidates[next++ % candidates.length]!, window);
    assert.equal(distinctFromClock(safe, window), true);
    const canary = String(safe).padStart(6, "0");
    for (let at = window.sinceMs; at <= window.throughMs; at++) assert.equal(String(at).includes(canary), false);
    for (const at of [window.sinceMs, window.sinceMs + 500, window.throughMs]) {
      const text = String(at);
      for (let offset = 0; offset <= text.length - 6; offset++) assert.equal(distinctFromClock(Number(text.slice(offset, offset + 6)), window), false);
    }
  }
});

test("clinical canary sampling cannot change crypto outside the isolated compiled fixture", () => {
  const before = crypto.randomInt, prior = process.env.ABBY_VOICE_TEST_MODE;
  process.env.ABBY_VOICE_TEST_MODE = "0";
  try { assert.throws(() => installClinicalVerificationCanaries(), /isolated clinical/); assert.equal(crypto.randomInt, before); }
  finally { if (prior === undefined) delete process.env.ABBY_VOICE_TEST_MODE; else process.env.ABBY_VOICE_TEST_MODE = prior; }
});

test("resend canary sampling cannot change crypto for another workflow", () => {
  const before = crypto.randomInt, prior = process.env.ABBY_SYNTHETIC_CLINICAL_OPERATION;
  process.env.ABBY_SYNTHETIC_CLINICAL_OPERATION = "book";
  try { assert.throws(() => installResendVerificationCanaries(), /isolated resend/); assert.equal(crypto.randomInt, before); }
  finally { if (prior === undefined) delete process.env.ABBY_SYNTHETIC_CLINICAL_OPERATION; else process.env.ABBY_SYNTHETIC_CLINICAL_OPERATION = prior; }
});
test("synthetic canary sampling remains bounded and requires the isolated staged class process", () => {
  const window = { sinceMs: 1792470200000, throughMs: 1792470860000 };
  assert.throws(() => drawDistinctCode(() => 179247, window), /exhausted/);
  assert.throws(() => drawDistinctCode(() => 0, { sinceMs: 0, throughMs: 1 }), /Invalid/);
  const before = crypto.randomInt, prior = process.env.ABBY_SYNTHETIC_CLASS_QUOTA_STAGING;
  process.env.ABBY_SYNTHETIC_CLASS_QUOTA_STAGING = "0";
  try { assert.throws(() => installStagedVerificationCanaries(), /isolated staged class/); assert.equal(crypto.randomInt, before); }
  finally { if (prior === undefined) delete process.env.ABBY_SYNTHETIC_CLASS_QUOTA_STAGING; else process.env.ABBY_SYNTHETIC_CLASS_QUOTA_STAGING = prior; }
});


test("past legitimate timestamp exclusions are additional to the bounded future window", () => {
  const window = { sinceMs: 1792470200000, throughMs: 1792470860000 };
  const candidates = [818181, 707070, 234567, 999999, 100000].filter(v => distinctFromClock(v, window));
  assert.ok(candidates.length >= 2);
  const excluded = new Set([String(candidates[0]).padStart(6, "0")]); let calls = 0;
  const code = drawDistinctCode(() => candidates[calls++ === 0 ? 0 : 1]!, window, excluded);
  assert.equal(code, candidates[1]); assert.equal(calls, 2); assert.equal(distinctFromClock(code, window), true);
  assert.throws(() => drawDistinctCode(() => candidates[0]!, window, excluded), /exhausted/);
  assert.throws(() => drawDistinctCode(() => candidates[0]!, window, new Set(["not-a-code"])), /Invalid/);
});

test("direct SQL canary instrumentation cannot change crypto in an unrelated test worker", () => {
  const before = crypto.randomInt;
  assert.throws(() => assertDirectSqlVerificationCanaryContext(), /isolated direct SQL/);
  assert.throws(() => installDirectSqlVerificationCanaries(new Set()), /isolated direct SQL/);
  assert.equal(crypto.randomInt, before);
});
