import type { PolicyStore } from "../../src/core/host.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import type { ClinicVoiceSettingStore } from "../../src/core/clinic-voice-setting.ts";
import { defaultVoicePreferences, voiceClinicScope } from "../../src/core/voice-profile.ts";
import type { VoiceClinicScope } from "../../src/core/voice-profile.ts";
import { captureVoiceProfile } from "../../src/core/voice-profile-registry.ts";
import type { VoiceProfileDeclaration, VoiceProfileRegistry } from "../../src/core/voice-profile-registry.ts";

export const voiceScope = (): VoiceClinicScope => ({ tenantId: `voice-${randomUUID()}`, clinicId: "clinic" });
export function value<T>(result: Result<T, { kind: string }>): T {
  assert.ok(result.ok, result.ok ? "" : result.error.kind); return result.value;
}
export function voiceDeclaration(scope: VoiceClinicScope): VoiceProfileDeclaration {
  const pair = (locale: string, voiceId: string, hash: string) => ({ locale, voiceId, ready: true,
    configurationHash: hash.repeat(64), transcriptionVersion: "stt.v1", synthesisVersion: "tts.v1", presentationVersion: "english.v1", qualityVersion: "quality.v1" });
  return { scope: structuredClone(scope), hostVersion: "voice-host.v1",
    locales: [{ id: "en-AU", label: "English (Australia)" }, { id: "en-US", label: "English (United States)" }],
    voices: [{ id: "coral", label: "Coral" }, { id: "cedar", label: "Cedar" }],
    profiles: [pair("en-AU", "coral", "1"), pair("en-US", "coral", "2"), pair("en-AU", "cedar", "3")] };
}
export const voiceRegistry = (): VoiceProfileRegistry => ({ resolve: async scope => ok(voiceDeclaration(scope)) });
export function voiceSettingsContract(label: string, create: (registry: VoiceProfileRegistry) => ClinicVoiceSettingStore): void {
  const prefix = `E2E-258 E2E-259 ${label}`;
  test(`${prefix} unset locale and voice are isolated public preferences with no call readiness`, async () => {
    const scope = voiceScope(), store = create(voiceRegistry());
    assert.deepEqual(await store.read(scope), ok(defaultVoicePreferences()));
    assert.deepEqual(await captureVoiceProfile(voiceRegistry(), scope, defaultVoicePreferences()), { ok: false, error: { kind: "readinessFailed", missing: ["voiceProfile"] } });
    assert.ok((await store.change(scope, "0", "locale", "en-AU", "owner")).ok);
    for (const other of [{ ...scope, clinicId: "other" }, { ...scope, tenantId: `${scope.tenantId}-other` }]) {
      assert.deepEqual(await store.read(other), ok(defaultVoicePreferences()));
      assert.deepEqual(await store.listChanges(other), ok({ entries: [] }));
    }
    const detached = value(await store.read(scope)) as { locale: string | null };
    detached.locale = "en-US";
    assert.equal(value(await store.read(scope)).locale, "en-AU");
  });
  test(`${prefix} compatible set change and clear preserve captured profiles and targeted audit`, async () => {
    const scope = voiceScope(), registry = voiceRegistry(), store = create(registry);
    assert.ok((await store.change(scope, "0", "locale", "en-AU", "owner")).ok);
    assert.equal((await captureVoiceProfile(registry, scope, value(await store.read(scope)))).ok, false);
    assert.ok((await store.change(scope, "1", "voiceId", "coral", "owner")).ok);
    const captured = value(await captureVoiceProfile(registry, scope, value(await store.read(scope))));
    assert.ok((await store.change(scope, "2", "voiceId", "cedar", "owner")).ok);
    assert.deepEqual(await store.change(scope, "3", "locale", "en-US", "owner"), { ok: false, error: { kind: "readinessFailed", missing: ["voiceProfile"] } });
    assert.equal(value(await store.read(scope)).version, "3");
    assert.equal(captured.voiceId, "coral"); assert.equal(captured.settingsVersion, "2");
    assert.ok((await store.change(scope, "3", "voiceId", null, "owner")).ok);
    assert.equal((await captureVoiceProfile(registry, scope, value(await store.read(scope)))).ok, false);
    assert.ok((await store.change(scope, "4", "locale", "en-US", "owner")).ok);
    assert.ok((await store.change(scope, "5", "voiceId", "coral", "owner")).ok);
    const future = value(await captureVoiceProfile(registry, scope, value(await store.read(scope))));
    assert.equal(future.locale, "en-US"); assert.notEqual(future.configurationHash, captured.configurationHash);
    const entries = value(await store.listChanges(scope)).entries;
    assert.deepEqual(entries.map(({ version, kind, value, previousValue }) => ({ version, kind, value, previousValue })), [
      { version: "1", kind: "locale", value: "en-AU", previousValue: null },
      { version: "2", kind: "voiceId", value: "coral", previousValue: null },
      { version: "3", kind: "voiceId", value: "cedar", previousValue: "coral" },
      { version: "4", kind: "voiceId", value: null, previousValue: "cedar" },
      { version: "5", kind: "locale", value: "en-US", previousValue: "en-AU" },
      { version: "6", kind: "voiceId", value: "coral", previousValue: null },
    ]);
    assert.ok(entries.every(entry => entry.actorRef === "owner" && new Date(entry.changedAt).toISOString() === entry.changedAt));
    for (const field of ["configurationHash", "hostVersion", "patient", "recipient", "transcript", "apiKey"]) assert.equal(JSON.stringify(entries).includes(field), false);
  });
  test(`${prefix} withdrawal blocks new capture but permits clearing public preferences`, async () => {
    const scope = voiceScope(); let withdrawn = false, unready = false;
    const registry: VoiceProfileRegistry = { resolve: async bound => {
      if (withdrawn) throw new Error("PRIVATE_PROVIDER_FAILURE");
      const declaration = voiceDeclaration(bound);
      return ok({ ...declaration, profiles: declaration.profiles.map(pair => ({ ...pair, ready: !unready })) });
    } };
    const store = create(registry);
    assert.ok((await store.change(scope, "0", "locale", "en-AU", "owner")).ok);
    unready = true;
    assert.equal((await store.change(scope, "1", "voiceId", "coral", "owner")).ok, false);
    unready = false;
    assert.ok((await store.change(scope, "1", "voiceId", "coral", "owner")).ok);
    const captured = value(await captureVoiceProfile(registry, scope, value(await store.read(scope))));
    withdrawn = true;
    assert.equal((await captureVoiceProfile(registry, scope, value(await store.read(scope)))).ok, false);
    assert.equal(captured.voiceId, "coral");
    assert.ok((await store.change(scope, "2", "locale", null, "owner")).ok);
    assert.ok((await store.change(scope, "3", "voiceId", null, "owner")).ok);
    assert.deepEqual(await store.read(scope), ok({ ...defaultVoicePreferences(), version: "4" }));
  });
  test(`${prefix} locale voice and location edits share one clinic CAS winner`, async () => {
    const scope = voiceScope(), store = create(voiceRegistry());
    const results = await Promise.all([
      store.change(voiceClinicScope({ ...scope, locationId: "first" }), "0", "locale", "en-AU", "first-owner"),
      store.change(voiceClinicScope({ ...scope, locationId: "second" }), "0", "voiceId", "coral", "second-owner"),
    ]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.deepEqual(results.find(result => !result.ok), { ok: false, error: { kind: "versionConflict" } });
    assert.equal(value(await store.listChanges(scope)).entries.length, 1);
    assert.deepEqual(await store.change(scope, "0", "locale", "en-US", "stale-owner"), { ok: false, error: { kind: "versionConflict" } });
  });
  test(`${prefix} invalid edits cannot write settings or audit`, async () => {
    const scope = voiceScope(), store = create(voiceRegistry());
    const invalid: readonly [string, string | null][] = [["locale", "en-au"], ["locale", "en-US-u-ca-hebrew"], ["locale", ""],
      ["voiceId", "coral\n"], ["voiceId", "https://private.example/voice"], ["model", "coral"]];
    for (const [kind, selected] of invalid) assert.deepEqual(await store.change(scope, "0", kind as "locale", selected, "owner"), { ok: false, error: { kind: "invalidValue" } });
    assert.deepEqual(await store.change(scope, "01", "locale", "en-AU", "owner"), { ok: false, error: { kind: "invalidValue" } });
    assert.deepEqual(await store.change(scope, "0", "locale", "en-AU", ""), { ok: false, error: { kind: "invalidValue" } });
    assert.equal((await store.change(scope, "0", "locale", "fr-FR", "owner")).ok, false);
    assert.equal((await store.change(scope, "0", "voiceId", "unapproved", "owner")).ok, false);
    assert.deepEqual(await store.read(scope), ok(defaultVoicePreferences()));
    assert.deepEqual(await store.listChanges(scope), ok({ entries: [] }));
  });
  test(`${prefix} public audit pages retain strict shared ordering and clone isolation`, async () => {
    const scope = voiceScope(), store = create(voiceRegistry());
    for (let i = 0; i < 55; i++) assert.ok((await store.change(scope, String(i), "locale", i % 2 ? "en-US" : "en-AU", "owner")).ok);
    const first = value(await store.listChanges(scope)), second = value(await store.listChanges(scope, first.nextAfterVersion));
    assert.equal(first.entries.length, 50); assert.equal(first.nextAfterVersion, 50);
    assert.equal(second.entries.length, 5); assert.equal(second.nextAfterVersion, undefined);
    assert.deepEqual([...first.entries, ...second.entries].map(row => Number(row.version)), Array.from({ length: 55 }, (_, i) => i + 1));
    (first.entries[0] as { actorRef: string }).actorRef = "forged";
    assert.equal(value(await store.listChanges(scope)).entries[0]?.actorRef, "owner");
    assert.deepEqual(await store.listChanges(scope, -1), { ok: false, error: { kind: "invalidValue" } });
  });
}

export function voicePolicyMutationContract(label: string, create: (registry: VoiceProfileRegistry) => PolicyStore): void {
  test(`E2E-258 E2E-259 ${label} policy change retains the authorized location across asynchronous host preflight`, async () => {
    const scope = { ...voiceScope(), locationId: "first" }, original = structuredClone(scope);
    let release: () => void = () => { throw new Error("preflight not entered"); };
    let entered: () => void = () => {};
    const seen = new Promise<void>(resolve => { entered = resolve; });
    const registry: VoiceProfileRegistry = { resolve: async bound => {
      await new Promise<void>(resolve => { release = resolve; entered(); });
      return ok(voiceDeclaration(bound));
    } };
    const policy = create(registry);
    const pending = policy.changeVoiceSetting(scope, "0", "locale", "en-AU", "owner");
    await Promise.race([seen, pending.then(() => { throw new Error("edit ended before host preflight"); })]);
    scope.tenantId += "-mutated"; scope.clinicId = "foreign"; scope.locationId = "other"; release();
    const saved = value(await pending);
    assert.deepEqual(saved.scope, original);
    assert.deepEqual(saved.voiceSettings, { version: "1", locale: "en-AU", voiceId: null });
    assert.deepEqual(value(await policy.read(original)).voiceSettings, saved.voiceSettings);
    assert.deepEqual(value(await policy.read(scope)).voiceSettings, defaultVoicePreferences());
    assert.deepEqual(await policy.listVoiceChanges(scope), ok({ entries: [] }));
  });
}
