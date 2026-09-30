import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const env: NodeJS.ProcessEnv = { ...process.env,
  ABBY_VOICE_TEST_MODE: "1", ABBY_TWILIO_TEST_CALLER_NUMBER: "+6145550101",
  ABBY_TWILIO_PUBLIC_WEBHOOK_URL: "https://voice.example.test/twilio/inbound",
  ABBY_TWILIO_PUBLIC_STREAM_URL: "wss://voice.example.test/twilio/media/",
  ABBY_TWILIO_PUBLIC_FALLBACK_URL: "https://fallback.twil.io/staff",
  ABBY_TWILIO_TEST_NUMBER: "+6125550199", ABBY_TWILIO_FALLBACK_NUMBER: "+6125550188",
  ABBY_TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`, ABBY_TWILIO_AUTH_TOKEN: "synthetic-token",
};

function preflight(overrides: NodeJS.ProcessEnv = {}, mode = "--config-only") {
  return spawnSync(process.execPath, ["scripts/preflight-voice-public.ts", mode], {
    cwd: new URL("../../", import.meta.url), env: { ...env, ...overrides }, encoding: "utf8",
  });
}

test("public voice preflight validates distinct TLS, WSS and fallback routes without exposing credentials", () => {
  const valid = preflight();
  assert.equal(valid.status, 0);
  assert.match(valid.stdout, /configuration valid/);
  for (const [name, value] of [
    ["ABBY_TWILIO_PUBLIC_FALLBACK_URL", "https://voice.example.test/fallback"],
    ["ABBY_TWILIO_PUBLIC_STREAM_URL", "ws://voice.example.test/twilio/media/"],
    ["ABBY_TWILIO_PUBLIC_WEBHOOK_URL", "https://voice.example.test/changed"],
    ["ABBY_TWILIO_FALLBACK_NUMBER", "+6125550199"],
    ["ABBY_TWILIO_TEST_CALLER_NUMBER", "+6125550188"],
  ] as const) {
    const rejected = preflight({ [name]: value });
    assert.equal(rejected.status, 1, name);
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /synthetic-token/);
  }
});

test("E2E-182 dry-run plans a separate POST fallback without credentials or Twilio writes", () => {
  const valid = preflight({ ABBY_TWILIO_ACCOUNT_SID: "", ABBY_TWILIO_AUTH_TOKEN: "" }, "--dry-run");
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), {
    testNumber: env.ABBY_TWILIO_TEST_NUMBER,
    primary: { url: env.ABBY_TWILIO_PUBLIC_WEBHOOK_URL, method: "POST" },
    streamUrl: env.ABBY_TWILIO_PUBLIC_STREAM_URL,
    fallback: { url: env.ABBY_TWILIO_PUBLIC_FALLBACK_URL, method: "POST" },
    fallbackDestinationLast4: "0188",
    voiceApplicationSid: null,
    trunkSid: null,
    applied: false,
  });
  assert.doesNotMatch(valid.stdout + valid.stderr, /synthetic-token|\+6125550188/);
  const shortDestination = preflight({ ABBY_TWILIO_FALLBACK_NUMBER: "+1234" }, "--dry-run");
  assert.equal(shortDestination.status, 0);
  assert.equal(JSON.parse(shortDestination.stdout).fallbackDestinationLast4, null);
  assert.doesNotMatch(shortDestination.stdout, /\+1234/);
  for (const [name, value] of [
    ["ABBY_TWILIO_PUBLIC_FALLBACK_URL", "https://voice.example.test/fallback"],
    ["ABBY_TWILIO_FALLBACK_NUMBER", "+6125550199"],
    ["ABBY_TWILIO_TEST_CALLER_NUMBER", "+6125550188"],
  ] as const) {
    const rejected = preflight({ [name]: value }, "--dry-run");
    assert.equal(rejected.status, 1, name);
    assert.equal(rejected.stdout, "");
  }
});

test("transport-only preflight rejects mismatched public routes before Twilio provisioning", () => {
  const result = spawnSync(process.execPath, ["scripts/preflight-voice-public.ts", "--transport-only"], {
    cwd: new URL("../../", import.meta.url), encoding: "utf8",
    env: { PATH: process.env.PATH,
      ABBY_TWILIO_PUBLIC_WEBHOOK_URL: "https://voice.example.test/twilio/inbound",
      ABBY_TWILIO_PUBLIC_STREAM_URL: "wss://other.example.test/twilio/media/" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /preflight failed/);
});
