import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const prefix of ["-", "_"])
test(`actual verified booking accepts an issuer reference beginning ${prefix}`, { timeout: 25_000 }, () => {
  // Restrict only the first six random bits in this isolated synthetic child.
  // It still executes the real verifier, recipient reader and booking host.
  const env: NodeJS.ProcessEnv = { ...process.env, ABBY_TEST_VERIFIER_PREFIX: prefix, NODE_OPTIONS: "--max-old-space-size=192" };
  // A nested Node runner needs its own reporter, rather than inheriting the
  // outer worker's private test channel. Assert one real child test executed.
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--import",
    new URL("../support/force-verifier-prefix.mjs", import.meta.url).href,
    "--test", "--test-reporter=tap", "--test-name-pattern=^actual booking host uses clinic file fees",
    "test/cliniko/approved-financial-booking-host.test.ts"], {
    cwd: new URL("../../", import.meta.url), encoding: "utf8", timeout: 20_000, maxBuffer: 1_000_000,
    env
  });
  assert.equal(child.error, undefined, "the isolated original booking-host test must finish normally");
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, `the real booking host must accept canonical issuer prefix ${prefix}`);
  assert.match(child.stdout, /ok 1 - actual booking host uses clinic file fees/);
  assert.match(child.stdout, /# tests 1\r?\n/);
  assert.match(child.stdout, /# pass 1\r?\n/);
  assert.match(child.stdout, /# fail 0\r?\n/);
});
