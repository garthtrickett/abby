import assert from "node:assert/strict";
import type { Kysely } from "kysely";
import type { VoiceClinicScope } from "../../src/core/voice-profile.ts";
import type Database from "../../src/storage/generated/Database.ts";
import { PostgresClinicVoiceSettingStore } from "../../src/storage/postgres-clinic-voice-settings.ts";
import { voiceRegistry } from "./voice-settings-contract.ts";

/** Explicit public preferences for an isolated synthetic caller; grants no production speech readiness. */
export async function seedSyntheticVoicePreferences(db: Kysely<Database>, scope: VoiceClinicScope): Promise<void> {
  assert.equal(process.env.ABBY_ISOLATED_POSTGRES_PROBE, "1", "synthetic voice preferences require an isolated fixture");
  const store = new PostgresClinicVoiceSettingStore(db, voiceRegistry());
  assert.ok((await store.change(scope, "0", "locale", "en-AU", "synthetic-voice-owner")).ok);
  assert.ok((await store.change(scope, "1", "voiceId", "coral", "synthetic-voice-owner")).ok);
}

/** Test-only scoped evidence for the actual provider factory; never an approval for real speech. */
export function syntheticSpeechQuality(scope: VoiceClinicScope): NonNullable<import("../../src/voice/openai-voice-profile.ts").OpenAIVoiceProfileConfig["quality"]> {
  assert.equal(process.env.ABBY_ISOLATED_POSTGRES_PROBE, "1", "synthetic speech quality requires an isolated fixture");
  const expected = structuredClone(scope);
  return (candidate, configurationHash) => candidate.tenantId === expected.tenantId && candidate.clinicId === expected.clinicId
    ? { ok: true, value: { configurationHash, qualityVersion: "synthetic-speech-quality.v1" } }
    : { ok: false, error: { kind: "readinessFailed", missing: ["voiceProfile"] } };
}
