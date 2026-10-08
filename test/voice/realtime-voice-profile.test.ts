import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIVoiceProfileHost } from "../../src/voice/openai-voice-profile.ts";
import { captureVoiceProfile } from "../../src/core/voice-profile-registry.ts";
import { ok } from "../../src/core/model.ts";
import { syntheticRealtimeSpeech } from "../support/synthetic-realtime-speech.ts";
import { value } from "../support/voice-settings-contract.ts";
import { serveClinikoVoice } from "../../scripts/serve-cliniko-voice.ts";

const scope = { tenantId: "synthetic", clinicId: "main" };
const runtime = { playbackOptions: { firstChunkDeadlineMs: 5_000 } };
const model = "gpt-realtime-2.1-mini";
const quality: NonNullable<ConstructorParameters<typeof OpenAIVoiceProfileHost>[0]["quality"]> =
  (_scope, configurationHash) => ok({ configurationHash, qualityVersion: "synthetic-only.v1" });
function host(options: Partial<ConstructorParameters<typeof OpenAIVoiceProfileHost>[0]> = {}) {
  return new OpenAIVoiceProfileHost({ apiKey: "synthetic-profile-key", mode: "keypadAvailability", quality, ...options });
}
async function profile(h: OpenAIVoiceProfileHost) {
  return value(await captureVoiceProfile(h, scope, { version: "2", locale: "en-AU", voiceId: "coral" }));
}

test("E2E-128 replacement binding preserves legacy hashes and requires distinct exact configuration evidence", async () => {
  const legacy = await profile(host());
  assert.equal(legacy.configurationHash, "8aff7082c713f2118747d8f456934d8ec3a57b74dab49d3fa11c6f4479aac440");
  assert.equal((await profile(host({ fallbackModel: "tts-1", runtime }))).configurationHash,
    "18a3fb886a2c9ab1422474df53d24a763df3849e5771f0462aa2f3fe97432b52");
  const provider = syntheticRealtimeSpeech(), replacement = host({ primaryModel: model, runtime, speechSocketFactory: provider.socketFactory });
  const current = await profile(replacement);
  assert.notEqual(current.configurationHash, legacy.configurationHash);
  assert.equal(current.synthesisVersion, "openai-bound-speech.v2");
  assert.equal(replacement.create(legacy, "session", {}).ok, false);
  assert.equal(replacement.create(current, "session", {}).ok, false);
  assert.equal(host({ primaryModel: model, runtime, quality: () => ok({ configurationHash: legacy.configurationHash,
    qualityVersion: "synthetic-only.v1" }) }).create(current, "session", runtime).ok, false);
  assert.equal((await captureVoiceProfile(new OpenAIVoiceProfileHost({ apiKey: "synthetic-profile-key",
    mode: "keypadAvailability", primaryModel: model, runtime }), scope,
    { version: "2", locale: "en-AU", voiceId: "coral" })).ok, false);
  assert.equal(provider.sockets.length, 0);
});

test("E2E-128 runner speech selection and evidence cannot bypass the isolated synthetic guard", async () => {
  const env = { ABBY_VOICE_PORT: "33334", DATABASE_URL: "postgresql://invalid.example/abby_test_voice_guard",
    ABBY_CLINIKO_API_KEY: "synthetic-key-au5", ABBY_TENANT_ID: "synthetic", ABBY_CLINIC_ID: "main", ABBY_LOCATION_ID: "main",
    ABBY_TWILIO_TEST_NUMBER: "+6125550199", ABBY_TWILIO_FALLBACK_NUMBER: "+6125550188", ABBY_TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
    ABBY_VOICE_ROUTE_VERSION: "synthetic.v1", ABBY_CLINIKO_CONTACT_EMAIL: "synthetic@example.test",
    ABBY_VOICE_TEST_MODE: "1", ABBY_ISOLATED_POSTGRES_PROBE: "0" };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    for (const ports of [{ speechModels: { primary: model } }, { speechQuality: quality },
      { speechSocketFactory: syntheticRealtimeSpeech().socketFactory }]) {
      await assert.rejects(serveClinikoVoice(ports), /synthetic speech configuration requires an isolated fixture/);
    }
  } finally {
    for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("E2E-128 replacement binding intersects voices for either fallback direction and leaves unknown models unready", async () => {
  for (const options of [{ primaryModel: model }, { primaryModel: model, fallbackModel: "tts-1" },
    { primaryModel: "tts-1", fallbackModel: model }]) {
    const h = host({ ...options, runtime });
    const catalogue = value(await h.resolve(scope));
    assert.ok(catalogue.voices.some(v => v.id === "coral"));
    assert.equal(catalogue.voices.some(v => ["fable", "nova", "onyx"].includes(v.id)), false);
    assert.equal(catalogue.voices.some(v => v.id === "cedar"), !options.fallbackModel);
  }
  assert.equal((await host({ primaryModel: "unknown-model" }).resolve(scope)).ok, false);
});

test("E2E-128 replacement profile constructs its selected Realtime adapter and uses the captured voice", async () => {
  const provider = syntheticRealtimeSpeech();
  const h = host({ primaryModel: model, runtime, speechSocketFactory: provider.socketFactory,
    customTranscription: { version: "synthetic-transcription.v1", create: () => ({ async accept() { return ok([]); }, async flush() { return ok([]); } }) },
    fetch: async () => { throw new Error("HTTP speech must not be selected"); } });
  const bound = value(h.create(await profile(h), "synthetic-session", runtime));
  const chunks: Uint8Array[] = [];
  for await (const chunk of bound.synthesis.stream("The appointment is not confirmed. Please call on Thursday.", new AbortController().signal)) chunks.push(chunk);
  assert.deepEqual(chunks.map(c => c.length), [640, 640, 320]);
  assert.equal(provider.requests[0]?.voice, "coral"); assert.equal(provider.requests[0]?.model, model);
  assert.equal(provider.sockets[0]?.closeCount, 1);
});
