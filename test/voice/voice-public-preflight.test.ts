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

function preflight(overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["scripts/preflight-voice-public.ts", "--config-only"], {
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
