import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "kysely";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { value } from "../support/voice-settings-contract.ts";
import { profilePatientCanary, withStandaloneVoiceProfile } from "../support/standalone-voice-profile.ts";

for (const [kind, scenario] of [["locale", "E2E-258"], ["voiceId", "E2E-259"]] as const) {
  test(`${scenario} signed standalone PostgreSQL setting drives real adapter requests and retains active calls`,
    { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => withStandaloneVoiceProfile(async app => {
    const denied = async () => {
      const before = [app.requests.length, app.providers.length, app.reads()];
      const call = await app.openCall(); assert.equal(call.ready, false); await call.close();
      assert.deepEqual([app.requests.length, app.providers.length, app.reads()], before);
    };
    await denied();
    assert.ok((await app.policy.changeVoiceSetting(app.scope, "0", "locale", "en-AU", "synthetic-owner")).ok);
    await denied();
    assert.ok((await app.policy.changeVoiceSetting(app.scope, "1", "voiceId", "coral", "synthetic-owner")).ok);
    const old = await app.openCall(); assert.equal(old.ready, true);
    assert.equal(app.requests.at(-1)?.voice, "coral");
    const transcription = app.providers[0]!.sessions[0] as { audio: { input: { transcription: { model: string; languages: string[] } } } };
    assert.equal(transcription.audio.input.transcription.model, "gpt-live-transcribe");
    assert.deepEqual(transcription.audio.input.transcription.languages, ["en"]);
    assert.ok((await app.policy.changeVoiceSetting({ ...app.scope, locationId: "second" }, "2", kind,
      kind === "locale" ? "en-US" : "cedar", "synthetic-owner")).ok);
    const future = await app.openCall(); assert.equal(future.ready, true);
    await old.availability(); assert.equal(app.requests.at(-1)?.voice, "coral"); assert.match(app.requests.at(-1)!.input, /4 October/);
    await future.availability(); assert.equal(app.requests.at(-1)?.voice, kind === "voiceId" ? "cedar" : "coral");
    assert.match(app.requests.at(-1)!.input, kind === "locale" ? /October 4/ : /4 October/);
    const audit = value(await app.policy.listVoiceChanges(app.scope)); assert.equal(audit.entries.length, 3);
    // Withdraw evidence while both saved preferences are still complete. A
    // missing preference must not mask the readiness gate in this proof.
    app.withdraw(); await denied();
    await old.availability(); assert.equal(app.requests.at(-1)?.voice, "coral"); assert.match(app.requests.at(-1)!.input, /4 October/);
    assert.ok((await app.policy.changeVoiceSetting(app.scope, "3", kind, null, "synthetic-owner")).ok);
    await denied();
    await old.availability(); assert.equal(app.requests.at(-1)?.voice, "coral"); assert.match(app.requests.at(-1)!.input, /4 October/);
    await old.close(); await future.close();
    assert.ok(app.providers.every(provider => provider.closeCount === 1));
    assert.equal(app.requests.some(request => request.input.includes(profilePatientCanary)), false);
    assert.deepEqual(await scanPatientDataCanaries(app.db, [{ label: "appointment", value: profilePatientCanary },
      { label: "caller", value: "+6145550101" }]), { ok: true, value: [] });
    const persisted = await sql<{ rows: number }>`select ((select count(*) from calls) + (select count(*) from call_events) +
      (select count(*) from pending_location_calls) + (select count(*) from effect_outbox))::int as rows`.execute(app.db);
    assert.equal(persisted.rows[0]?.rows, 0);
  }));
}
