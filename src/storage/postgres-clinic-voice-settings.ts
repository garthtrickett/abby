import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { PolicyFailure } from "../core/host.ts";
import { validVoiceChange } from "../core/clinic-voice-setting.ts";
import type { ClinicVoiceSettingStore, VoiceSettingAuditEntry, VoiceSettingAuditPage } from "../core/clinic-voice-setting.ts";
import { defaultVoicePreferences, validVoiceCursor, validVoicePreferences, validVoiceRef, validVoiceScope,
  validVoiceSettingKind, validVoiceSettingValue } from "../core/voice-profile.ts";
import type { VoiceClinicScope, VoicePreferences, VoiceSettingKind } from "../core/voice-profile.ts";
import { approveVoiceChange, unprovenVoiceProfileRegistry } from "../core/voice-profile-registry.ts";
import type { VoiceProfileRegistry } from "../core/voice-profile-registry.ts";
import type Database from "./generated/Database.ts";
import type { ClinicVoiceSettingsClinicId, ClinicVoiceSettingsTenantId, ClinicVoiceSettingsVersion } from "./generated/public/ClinicVoiceSettings.ts";

function ids(scope: VoiceClinicScope) {
  return { tenant_id: scope.tenantId as ClinicVoiceSettingsTenantId, clinic_id: scope.clinicId as ClinicVoiceSettingsClinicId };
}
function decode(version: number, locale: string | null, voiceId: string | null): Result<VoicePreferences, PolicyFailure> {
  const state = { version: String(version), locale, voiceId };
  return validVoicePreferences(state) ? ok(state) : err({ kind: "storageFailure" });
}
export class PostgresClinicVoiceSettingStore implements ClinicVoiceSettingStore {
  private readonly db: Kysely<Database>;
  private readonly registry: VoiceProfileRegistry;
  constructor(db: Kysely<Database>, registry: VoiceProfileRegistry = unprovenVoiceProfileRegistry) {
    this.db = db;
    this.registry = registry;
  }
  async read(scope: VoiceClinicScope): Promise<Result<VoicePreferences, PolicyFailure>> {
    if (!validVoiceScope(scope)) return err({ kind: "invalidValue" });
    try {
      const key = ids(scope);
      const row = await this.db.selectFrom("clinic_voice_settings").select(["version", "locale", "voice_id"])
        .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id)
        .orderBy("version", "desc").limit(1).executeTakeFirst();
      return row ? decode(row.version, row.locale, row.voice_id) : ok(defaultVoicePreferences());
    } catch { return err({ kind: "storageFailure" }); }
  }
  async change(scope: VoiceClinicScope, expectedVersion: string, kind: VoiceSettingKind, value: string | null,
    actorRef: string): Promise<Result<VoicePreferences, PolicyFailure>> {
    if (!validVoiceChange(scope, expectedVersion, kind, value, actorRef)) return err({ kind: "invalidValue" });
    const bound = structuredClone(scope);
    const observed = await this.read(bound);
    if (!observed.ok) return observed;
    if (observed.value.version !== expectedVersion) return err({ kind: "versionConflict" });
    const candidate = { ...observed.value, [kind]: value, version: String(Number(expectedVersion) + 1) };
    const approved = await approveVoiceChange(this.registry, bound, candidate, kind);
    if (!approved.ok) return approved;
    try {
      return await this.db.transaction().execute(async trx => {
        const key = ids(bound);
        await trx.insertInto("clinic_voice_settings").values({ ...key, version: 0 as ClinicVoiceSettingsVersion,
          locale: null, voice_id: null }).onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "version"]).doNothing()).execute();
        await trx.selectFrom("clinic_voice_settings").select("version")
          .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id)
          .where("version", "=", 0 as ClinicVoiceSettingsVersion).forUpdate().executeTakeFirstOrThrow();
        const row = await trx.selectFrom("clinic_voice_settings").select(["version", "locale", "voice_id"])
          .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id)
          .orderBy("version", "desc").limit(1).executeTakeFirstOrThrow();
        const previous = decode(row.version, row.locale, row.voice_id);
        if (!previous.ok) return previous;
        if (previous.value.version !== expectedVersion) return err({ kind: "versionConflict" });
        // Pair preflight used these exact preferences; in-place tampering cannot change its counterpart.
        if (previous.value.locale !== observed.value.locale || previous.value.voiceId !== observed.value.voiceId) return err({ kind: "storageFailure" });
        await trx.insertInto("clinic_voice_settings").values({ ...key, version: Number(candidate.version) as ClinicVoiceSettingsVersion,
          locale: candidate.locale, voice_id: candidate.voiceId, setting_kind: kind, setting_value: value,
          previous_value: previous.value[kind], changed_by: actorRef, changed_at: sql`clock_timestamp()` }).execute();
        return ok(candidate);
      });
    } catch { return err({ kind: "storageFailure" }); }
  }
  async listChanges(scope: VoiceClinicScope, afterVersion?: number): Promise<Result<VoiceSettingAuditPage, PolicyFailure>> {
    if (!validVoiceScope(scope) || !validVoiceCursor(afterVersion)) return err({ kind: "invalidValue" });
    try {
      const key = ids(scope);
      const rows = await this.db.selectFrom("clinic_voice_settings")
        .select(["version", "setting_kind", "setting_value", "previous_value", "changed_by", "changed_at"])
        .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id)
        .where("version", ">", (afterVersion ?? 0) as ClinicVoiceSettingsVersion).orderBy("version", "asc").limit(50).execute();
      const entries: VoiceSettingAuditEntry[] = [];
      for (const row of rows) {
        if (!validVoiceSettingKind(row.setting_kind) || !validVoiceSettingValue(row.setting_kind, row.setting_value) ||
            !validVoiceSettingValue(row.setting_kind, row.previous_value) || !validVoiceRef(row.changed_by) ||
            !(row.changed_at instanceof Date) || !Number.isFinite(row.changed_at.getTime())) return err({ kind: "storageFailure" });
        entries.push({ version: String(row.version), kind: row.setting_kind, value: row.setting_value,
          previousValue: row.previous_value, actorRef: row.changed_by, changedAt: row.changed_at.toISOString() });
      }
      return ok({ entries, ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
    } catch { return err({ kind: "storageFailure" }); }
  }
}
