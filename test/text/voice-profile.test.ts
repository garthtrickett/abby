import assert from "node:assert/strict";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { defaultVoicePreferences, validVoiceCatalogue, validVoiceProfile } from "../../src/core/voice-profile.ts";
import { approveVoiceChange, captureVoiceProfile, listVoiceOptions } from "../../src/core/voice-profile-registry.ts";
import type { VoiceProfileDeclaration, VoiceProfileRegistry } from "../../src/core/voice-profile-registry.ts";
import type { TimerPort } from "../../src/core/timer.ts";
import { MemoryClinicVoiceSettingStore } from "../../src/reference/clinic-voice-setting-store.ts";
import { voiceDeclaration, voiceRegistry, voiceScope, voiceSettingsContract, value } from "../support/voice-settings-contract.ts";

voiceSettingsContract("memory", registry => new MemoryClinicVoiceSettingStore(registry));
test("E2E-258 E2E-259 declarations reject cross-clinic duplicate contradictory and expanded host evidence", async () => {
  const scope = voiceScope(), settings = { version: "2", locale: "en-AU", voiceId: "coral" };
  const mutate: readonly ((row: VoiceProfileDeclaration) => unknown)[] = [
    row => ({ ...row, scope: { ...row.scope, clinicId: "other" } }),
    row => ({ ...row, apiKey: "PRIVATE_CREDENTIAL" }),
    row => ({ ...row, profiles: [...row.profiles, row.profiles[0]] }),
    row => ({ ...row, profiles: row.profiles.map(pair => ({ ...pair, configurationHash: "unpinned" })) }),
    row => ({ ...row, profiles: row.profiles.map(pair => ({ ...pair, ready: "true" })) }),
    row => ({ ...row, profiles: row.profiles.map(pair => ({ ...pair, model: "PRIVATE_MODEL" })) }),
    row => ({ ...row, voices: [] }),
  ];
  for (const change of mutate) {
    const registry: VoiceProfileRegistry = { resolve: async bound => ok(change(voiceDeclaration(bound)) as VoiceProfileDeclaration) };
    assert.deepEqual(await listVoiceOptions(registry, scope), ok({ scope, locales: [], voices: [], pairs: [] }));
    assert.equal((await captureVoiceProfile(registry, scope, settings)).ok, false);
  }
  const publicOptions = value(await listVoiceOptions(voiceRegistry(), scope));
  assert.ok(validVoiceCatalogue(publicOptions, scope));
  assert.equal(JSON.stringify(publicOptions).includes("configurationHash"), false);
  assert.equal(validVoiceCatalogue({ ...publicOptions, apiKey: "PRIVATE" }, scope), false);
});
test("E2E-258 E2E-259 host timeout aborts lookup and cannot grant call readiness", async () => {
  const scope = voiceScope(); let fire: (() => void) | undefined, seen: AbortSignal | undefined, canceled = false;
  const timer: TimerPort = { schedule: callback => { fire = callback; return "timer"; }, cancel: () => { canceled = true; } };
  const registry: VoiceProfileRegistry = { resolve: async (_, signal) => { seen = signal; return new Promise(() => {}); } };
  const pending = captureVoiceProfile(registry, scope, { version: "2", locale: "en-AU", voiceId: "coral" }, timer);
  await Promise.resolve(); assert.ok(seen); fire!();
  assert.equal((await pending).ok, false); assert.equal(seen.aborted, true); assert.equal(canceled, true);
});
test("E2E-258 E2E-259 captured binding and edit preflight snapshot mutable inputs before awaiting host", async () => {
  const scope = voiceScope(), settings = { version: "2", locale: "en-AU", voiceId: "coral" };
  let complete: (() => void) | undefined;
  const declaration = voiceDeclaration(scope);
  const registry: VoiceProfileRegistry = { resolve: async () => { await new Promise<void>(resolve => { complete = resolve; }); return ok(declaration); } };
  const pending = captureVoiceProfile(registry, scope, settings);
  await Promise.resolve(); settings.locale = "fr-FR"; (scope as { clinicId: string }).clinicId = "other"; complete!();
  const captured = value(await pending); assert.equal(captured.locale, "en-AU"); assert.equal(captured.scope.clinicId, "clinic");
  const candidate = { version: "3", locale: "en-AU", voiceId: "cedar" };
  const edit = approveVoiceChange(registry, declaration.scope, candidate, "voiceId");
  await Promise.resolve(); candidate.locale = "en-US"; complete!();
  assert.ok((await edit).ok);
  assert.equal(validVoiceProfile({ ...captured, apiKey: "PRIVATE" }, captured.scope), false);
  assert.equal(validVoiceProfile(captured, undefined as never), false);
});
test("E2E-258 E2E-259 a bad store clock leaves public preference and audit untouched", async () => {
  const scope = voiceScope(), store = new MemoryClinicVoiceSettingStore(voiceRegistry(), () => "invalid-clock");
  assert.deepEqual(await store.change(scope, "0", "locale", "en-AU", "owner"), { ok: false, error: { kind: "storageFailure" } });
  assert.deepEqual(await store.read(scope), ok(defaultVoicePreferences()));
  assert.deepEqual(await store.listChanges(scope), ok({ entries: [] }));
});
