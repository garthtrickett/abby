import assert from "node:assert/strict";
import test from "node:test";
import { withStandaloneVoiceProfile } from "../support/standalone-voice-profile.ts";
import { syntheticRealtimeSpeech } from "../support/synthetic-realtime-speech.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 };
async function waitFor(check: () => boolean) {
  const end = Date.now() + 8_000;
  while (!check()) { assert.ok(Date.now() < end, "Realtime binding observation timed out"); await new Promise(r => setTimeout(r, 10)); }
}
async function configure(app: Parameters<Parameters<typeof withStandaloneVoiceProfile>[0]>[0]) {
  assert.ok((await app.policy.changeVoiceSetting(app.scope, "0", "locale", "en-AU", "synthetic-owner")).ok);
  assert.ok((await app.policy.changeVoiceSetting(app.scope, "1", "voiceId", "coral", "synthetic-owner")).ok);
}

test("E2E-128 signed PostgreSQL runner binds replacement, withholds unvalidated audio and retains captured profiles", options, async () => {
  const speech = syntheticRealtimeSpeech(); speech.hold();
  await withStandaloneVoiceProfile(async app => {
    const absent = await app.openCall(); assert.equal(absent.ready, false); await absent.close();
    assert.equal(speech.sockets.length, 0); assert.equal(app.providers.length, 0); assert.equal(app.reads(), 0);
    await configure(app);
    const pending = app.openCall(false);
    await waitFor(() => speech.completions.length === 1);
    assert.equal(app.observations.at(-1)?.length, 0, "completed audio/transcript deltas cannot play a prefix");
    assert.equal(app.reads(), 0);
    speech.completions[0]!();
    const old = await pending; assert.equal(old.ready, true);
    assert.ok(old.messages.some(m => m.event === "media")); assert.ok(old.messages.some(m => m.event === "mark"));
    assert.equal(app.reads(), 0, "queue completion is not caller action or an availability read");
    await old.acknowledge(); speech.automatic();
    assert.ok((await app.policy.changeVoiceSetting(app.scope, "2", "voiceId", "marin", "synthetic-owner")).ok);
    const future = await app.openCall(); assert.equal(future.ready, true); assert.equal(speech.requests.at(-1)?.voice, "marin");
    await old.availability(); assert.equal(speech.requests.at(-1)?.voice, "coral");
    assert.match(speech.requests.at(-1)!.input, /4 October/);
    assert.equal(app.requests.length, 0, "replacement must not invoke legacy HTTP speech");
    app.withdraw(); const before = [speech.sockets.length, app.providers.length, app.reads()];
    const denied = await app.openCall(); assert.equal(denied.ready, false); await denied.close();
    assert.deepEqual([speech.sockets.length, app.providers.length, app.reads()], before);
    await future.availability(); assert.equal(speech.requests.at(-1)?.voice, "marin");
    await old.close(); await future.close();
    assert.ok(speech.sockets.every(s => s.closeCount === 1)); assert.ok(app.providers.every(p => p.closeCount === 1));
    assert.deepEqual(await scanPatientDataCanaries(app.db, [{ label: "synthetic_caller", value: "+6145550101" },
      { label: "greeting", value: speech.requests[0]!.input }]), { ok: true, value: [] });
  }, speech);
});

test("E2E-128 signed replacement mismatch or stalled completion closes without speech, marks or patient reads", options, async () => {
  for (const defect of ["mismatch", "stall"] as const) {
    const speech = syntheticRealtimeSpeech(); defect === "mismatch" ? speech.mismatch() : speech.hold();
    await withStandaloneVoiceProfile(async app => {
      await configure(app);
      const call = await app.openCall(); assert.equal(call.ready, false);
      assert.equal(call.messages.length, 0); assert.equal(app.reads(), 0); assert.equal(app.requests.length, 0);
      assert.equal(speech.sockets[0]?.closeCount, 1);
      speech.completions[0]!(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(call.messages.length, 0); await call.close();
    }, speech, 150);
  }
});
