import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distinctFromClock, drawDistinctCode, drawSqlCanaryCode, assertDirectSqlVerificationCanaryContext, installDirectSqlVerificationCanaries, installScopedDirectSqlVerificationCanaries, installClinicalVerificationCanaries, installResendVerificationCanaries, installStagedVerificationCanaries } from "../support/verification-code-canary.ts";

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
  assert.throws(() => installScopedDirectSqlVerificationCanaries(new Set()), /isolated direct SQL/);
  assert.equal(crypto.randomInt, before);
});


test("SQL canaries reject full microsecond fractions while preserving epoch and prior-clock exclusions", () => {
  const window = { sinceMs: 1792470200000, throughMs: 1792470860000 };
  const eligible = Array.from({ length: 100000 }, (_, i) => i * 10).filter(code => distinctFromClock(code, window));
  assert.ok(eligible.length > 10000);
  const excluded = new Set([String(eligible[0]).padStart(6, "0")]);
  const fraction = eligible.find(code => distinctFromClock(code + 1, window))! + 1;
  assert.ok(fraction % 10 !== 0 && distinctFromClock(fraction, window));
  const draws = [fraction, 179247, eligible[0]!, eligible[1]!]; let calls = 0;
  const result = drawSqlCanaryCode(() => draws[calls++]!, window, excluded);
  assert.equal(result, eligible[1]); assert.equal(result % 10, 0); assert.equal(calls, 4);
  assert.equal(excluded.has(String(result).padStart(6, "0")), false);
});

test("SQL canary selection is bounded with headroom for rejection sampling", () => {
  const window = { sinceMs: 1792470200000, throughMs: 1792470860000 }; let calls = 0;
  assert.throws(() => drawSqlCanaryCode(() => { calls++; return 999999; }, window), /exhausted/);
  assert.equal(calls, 4096);
  calls = 0;
  assert.equal(drawSqlCanaryCode(() => ++calls === 4096 ? 0 : 999999, window), 0);
  assert.equal(calls, 4096);
  assert.throws(() => drawSqlCanaryCode(() => 0, window, new Set(["bad"])), /Invalid/);
});


test("scoped SQL canaries restore named and default issuers without letting an old scope close a new one", () => {
  const folder = mkdtempSync(join(tmpdir(), "abby-canary-lifecycle-"));
  try {
    const directory = join(folder, "test", "storage"); mkdirSync(directory, { recursive: true });
    const entry = join(directory, "postgres-appointment-change-memo.test.ts");
    const source = new URL("../support/verification-code-canary.ts", import.meta.url).href;
    writeFileSync(entry, `import assert from "node:assert/strict";
import test from "node:test";
import crypto, { randomInt } from "node:crypto";
import { installScopedDirectSqlVerificationCanaries, distinctFromClock } from ${JSON.stringify(source)};
test("actual isolated SQL child canary lifetime", () => {
  const original = crypto.randomInt;
  const first = installScopedDirectSqlVerificationCanaries(new Set());
  try {
    assert.notEqual(crypto.randomInt, original); assert.equal(randomInt, crypto.randomInt);
    const drawn = randomInt(0, 1000000);
    assert.equal(drawn % 10, 0); assert.equal(distinctFromClock(drawn, first.window), true);
    assert.throws(() => installScopedDirectSqlVerificationCanaries(new Set()), /already installed/);
  } finally { first.close(); }
  assert.equal(crypto.randomInt, original); assert.equal(randomInt, original);
  const second = installScopedDirectSqlVerificationCanaries(new Set());
  try { const current = crypto.randomInt; first.close(); assert.equal(crypto.randomInt, current); }
  finally { second.close(); }
  assert.equal(crypto.randomInt, original); assert.equal(randomInt, original);
});
`);
    const env: NodeJS.ProcessEnv = { ...process.env, ABBY_ISOLATED_POSTGRES_PROBE: "1", DATABASE_URL: "postgresql://localhost/abby_test_canary_lifecycle" };
    delete env.NODE_TEST_CONTEXT;
    execFileSync(process.execPath, ["--test", entry], { env, timeout: 10000, stdio: "pipe" });
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
