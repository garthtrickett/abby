import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distinctFromClock, drawDistinctCode, drawSqlCanaryCode, assertDirectSqlVerificationCanaryContext, installDirectSqlVerificationCanaries, installScopedDirectSqlVerificationCanaries, installMemoRecoveryVerificationCanaries, installClinicalVerificationCanaries, installResendVerificationCanaries, installStagedVerificationCanaries } from "../support/verification-code-canary.ts";
import { withIsolatedVerificationSql, assertIsolatedVerificationCanary } from "../support/isolated-verification-sql.ts";

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

test("owned verification databases and negative probes refuse an unregistered test before opening SQL or changing crypto", async () => {
  const before = crypto.randomInt; let invoked = false;
  await assert.rejects(withIsolatedVerificationSql("postgresql://postgres@127.0.0.1:1/postgres", async () => { invoked = true; }), /isolated direct SQL/);
  await assert.rejects(assertIsolatedVerificationCanary("postgresql://postgres@127.0.0.1:1/postgres", "123450"), /isolated direct SQL/);
  assert.equal(invoked, false); assert.equal(crypto.randomInt, before);
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


test("cold memo canary sampling cannot change the issuer in another process", () => {
  const before = crypto.randomInt;
  assert.throws(() => installMemoRecoveryVerificationCanaries(new Set()), /isolated memo recovery sender/);
  assert.equal(crypto.randomInt, before);
});

test("cold memo sender rejects pre-challenge numbers and invalid contexts while restoring its exact issuer", () => {
  const folder = mkdtempSync(join(tmpdir(), "abby-cold-memo-canary-"));
  try {
    const directory = join(folder, "dist", "runtime", "test", "support"); mkdirSync(directory, { recursive: true });
    const entry = join(directory, "administrative-memo-recovery-worker.js");
    const source = new URL("../support/verification-code-canary.ts", import.meta.url).href;
    writeFileSync(entry, `import assert from "node:assert/strict";
import crypto, { randomInt } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { installMemoRecoveryVerificationCanaries, distinctFromClock } from ${JSON.stringify(source)};
const original = crypto.randomInt, descriptor = Object.getOwnPropertyDescriptor(crypto, "randomInt");
const good = "postgresql://127.0.0.1/abby_memo_cold_" + "a".repeat(32);
for (const database of ["postgresql://remote.invalid/abby_memo_cold_" + "a".repeat(32), "postgresql://127.0.0.1/postgres", "https://127.0.0.1/abby_memo_cold_" + "a".repeat(32)]) {
  process.env.DATABASE_URL = database;
  assert.throws(() => installMemoRecoveryVerificationCanaries(new Set()), /isolated memo recovery sender/);
  assert.equal(crypto.randomInt, original);
}
process.env.DATABASE_URL = good;
for (const invalid of [new Set(["not-a-code"]), new Set([111222])]) {
  assert.throws(() => installMemoRecoveryVerificationCanaries(invalid), /Invalid synthetic/);
  assert.equal(crypto.randomInt, original);
}
const now = Date.now(), window = { sinceMs: now - 65000, throughMs: now + 605000 };
const candidates = Array.from({ length: 100000 }, (_, i) => i * 10).filter(code => distinctFromClock(code, window));
assert.ok(candidates.length >= 2);
const [blocked, accepted] = candidates; let calls = 0;
Object.defineProperty(crypto, "randomInt", { ...descriptor, value: (...args) => args.length === 2 && args[0] === 0 && args[1] === 1000000
  ? (++calls === 1 ? blocked : accepted) : Reflect.apply(original, crypto, args) });
syncBuiltinESMExports();
const priorIssuer = crypto.randomInt, exclusions = new Set([String(blocked).padStart(6, "0")]);
const sampler = installMemoRecoveryVerificationCanaries(exclusions);
try {
  exclusions.add(String(accepted).padStart(6, "0"));
  assert.equal(randomInt(0, 1000000), accepted); assert.equal(calls, 2);
  assert.throws(() => installMemoRecoveryVerificationCanaries(new Set()), /already installed/);
} finally { sampler.close(); }
assert.equal(crypto.randomInt, priorIssuer); assert.equal(randomInt, priorIssuer);
Object.defineProperty(crypto, "randomInt", descriptor); syncBuiltinESMExports();
assert.equal(crypto.randomInt, original); assert.equal(randomInt, original);
`);
    execFileSync(process.execPath, [entry], { env: { ...process.env, ABBY_ISOLATED_POSTGRES_PROBE: "1" }, timeout: 10000, stdio: "pipe" });
    const numericInput = spawnSync(process.execPath, [new URL("../../dist/runtime/test/support/administrative-memo-recovery-worker.js", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, DATABASE_URL: "postgresql://127.0.0.1:1/abby_memo_cold_" + "a".repeat(32), ABBY_ISOLATED_POSTGRES_PROBE: "1" },
      input: JSON.stringify({ family: "classMovePartial", mode: "send", verificationCanaryExclusions: [111222],
        scope: { tenantId: "invalid-canary", clinicId: "clinic", locationId: "main" }, proxy: "http://127.0.0.1:1" }), timeout: 10000 });
    assert.equal(numericInput.error, undefined);
    assert.equal(numericInput.signal, null); assert.notEqual(numericInput.status, 0);
    assert.match(numericInput.stderr.toString(), /ERR_ASSERTION/);
    assert.doesNotMatch(numericInput.stderr.toString(), /isolated memo recovery sender|ECONNREFUSED/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("scoped SQL challenges reject prior public hash collisions without exempting issued secrets", () => {
  const folder = mkdtempSync(join(tmpdir(), "abby-public-code-canary-"));
  try {
    const directory = join(folder, "test", "storage"); mkdirSync(directory, { recursive: true });
    const entry = join(directory, "postgres-sql-verification-canary.test.ts");
    const source = new URL("../support/verification-code-canary.ts", import.meta.url).href;
    const progress = new URL("../../src/reference/command-progress.ts", import.meta.url).href;
    writeFileSync(entry, `import assert from "node:assert/strict";
import test from "node:test";
import crypto, { randomInt, createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { installScopedDirectSqlVerificationCanaries, drawSqlCanaryCode, distinctFromClock } from ${JSON.stringify(source)};
import { commandProgress } from ${JSON.stringify(progress)};
test("pre-issue public snapshot is an exclusion, never a privacy exemption", () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomInt"), original = crypto.randomInt;
  let draws = [], calls = 0;
  Object.defineProperty(crypto, "randomInt", { ...descriptor, value: (...args) => args.length === 2 && args[0] === 0 && args[1] === 1000000
    ? draws[Math.min(calls++, draws.length - 1)] : Reflect.apply(original, crypto, args) });
  syncBuiltinESMExports();
  const priorIssuer = crypto.randomInt, canary = installScopedDirectSqlVerificationCanaries(new Set());
  try {
    let collision;
    for (let seed = 0; seed < 256 && !collision; seed++) {
      const actionKey = createHash("sha256").update("prior-public-action:" + seed).digest("hex");
      for (const match of actionKey.matchAll(/[0-9]{6,}/g)) for (let i = 0; i <= match[0].length - 6; i++) {
        const code = Number(match[0].slice(i, i + 6));
        if (code % 10 === 0 && distinctFromClock(code, canary.window)) { collision = { actionKey, code }; break; }
      }
    }
    assert.ok(collision, "bounded deterministic public-hash witness");
    const state = { callId: "synthetic", version: 1, lifecycle: "active", actions: { [collision.actionKey]: {
      key: collision.actionKey, kind: "book", status: "committed", presentationId: collision.actionKey + ":details" } },
      staffItems: {}, presentations: {}, knowledgeAnswers: [], availabilityReads: [], appointmentReads: [] };
    const publicBeforeIssue = JSON.stringify(commandProgress(state, "multiple-patient-memo"));
    const blocked = String(collision.code).padStart(6, "0");
    assert.ok(publicBeforeIssue.includes(blocked));
    assert.equal(drawSqlCanaryCode(() => collision.code, canary.window), collision.code);
    const safe = Array.from({ length: 100000 }, (_, i) => i * 10).filter(code => distinctFromClock(code, canary.window) &&
      !publicBeforeIssue.includes(String(code).padStart(6, "0"))).slice(0, 2);
    assert.equal(safe.length, 2);
    canary.excludePreexistingPublicText(publicBeforeIssue);
    draws = [collision.code, safe[0]]; calls = 0;
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    assert.ok(code === String(safe[0]).padStart(6, "0") && calls === 2);
    assert.ok(!publicBeforeIssue.includes(code));
    const next = String(safe[1]).padStart(6, "0");
    assert.throws(() => canary.excludePreexistingPublicText(next + "|" + code), /already occurs in public snapshot/);
    draws = [safe[1]]; calls = 0;
    assert.ok(randomInt(0, 1000000) === safe[1], "a refused snapshot must add no partial exclusions");
    assert.throws(() => canary.excludePreexistingPublicText(JSON.stringify({ transcript: code })), /already occurs/);
    assert.throws(() => canary.excludePreexistingPublicText(null), /Invalid synthetic/);
    assert.throws(() => canary.excludePreexistingPublicText("x".repeat(8000001)), /Invalid synthetic/);
    draws = [collision.code]; calls = 0;
    assert.throws(() => randomInt(0, 1000000), /exhausted/); assert.equal(calls, 4096);
    assert.throws(() => assert.equal(publicBeforeIssue.includes(blocked), false));
    assert.throws(() => assert.equal(JSON.stringify({ transcript: code }).includes(code), false));
  } finally { canary.close(); }
  assert.equal(crypto.randomInt, priorIssuer); assert.equal(randomInt, priorIssuer);
  assert.throws(() => canary.excludePreexistingPublicText("123450"), /no longer owns/);
  const full = new Set(Array.from({ length: 100000 }, (_, i) => String(i).padStart(6, "0")));
  const second = installScopedDirectSqlVerificationCanaries(full);
  try {
    assert.throws(() => second.excludePreexistingPublicText("100000"), /declared bound/);
    assert.throws(() => canary.excludePreexistingPublicText("100000"), /no longer owns/);
  } finally { second.close(); Object.defineProperty(crypto, "randomInt", descriptor); syncBuiltinESMExports(); }
  assert.equal(crypto.randomInt, original); assert.equal(randomInt, original);
});
`);
    execFileSync(process.execPath, ["--test", entry], { env: { ...process.env, ABBY_ISOLATED_POSTGRES_PROBE: "1",
      DATABASE_URL: "postgresql://127.0.0.1/abby_test_public_canary" }, timeout: 10000, stdio: "pipe" });
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
