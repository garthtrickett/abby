import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { Result, LocationScope } from "../core/model.ts";
import type { PolicyFailure } from "../core/host.ts";
import { defaultNotificationSettings, resolveNotification, unprovenNotificationRegistry, validNotificationChange,
  validNotificationClinicScope, validNotificationCursor, validNotificationKind, validNotificationOwner,
  validNotificationSettings } from "../core/notification-policy.ts";
import type { ClinicNotificationSettingStore, NotificationAuditEntry, NotificationAuditPage, NotificationClinicScope,
  NotificationKind, NotificationOwner, NotificationRegistry, NotificationSettings } from "../core/notification-policy.ts";
import type Database from "./generated/Database.ts";
import type { ClinicNotificationSettingsTenantId, ClinicNotificationSettingsClinicId,
  ClinicNotificationSettingsVersion } from "./generated/public/ClinicNotificationSettings.ts";

function ids(scope: NotificationClinicScope) {
  return { tenant_id: scope.tenantId as ClinicNotificationSettingsTenantId,
    clinic_id: scope.clinicId as ClinicNotificationSettingsClinicId };
}
function decode(version: number, owners: unknown): Result<NotificationSettings, PolicyFailure> {
  const state = { version: String(version), owners };
  return validNotificationSettings(state) ? ok(state) : err({ kind: "storageFailure" });
}

export class PostgresClinicNotificationSettingStore implements ClinicNotificationSettingStore {
  private readonly db: Kysely<Database>;
  private readonly registry: NotificationRegistry;
  constructor(db: Kysely<Database>, registry: NotificationRegistry = unprovenNotificationRegistry) {
    this.db = db;
    this.registry = registry;
  }
  async read(scope: NotificationClinicScope): Promise<Result<NotificationSettings, PolicyFailure>> {
    if (!validNotificationClinicScope(scope)) return err({ kind: "invalidValue" });
    try {
      const key = ids(scope);
      const row = await this.db.selectFrom("clinic_notification_settings").select(["version", "owners"])
        .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id)
        .orderBy("version", "desc").limit(1).executeTakeFirst();
      return row ? decode(row.version, row.owners) : ok(defaultNotificationSettings());
    } catch { return err({ kind: "storageFailure" }); }
  }
  async changeOwner(scope: LocationScope, expectedVersion: string, kind: NotificationKind, owner: NotificationOwner | null,
    actorRef: string): Promise<Result<NotificationSettings, PolicyFailure>> {
    if (!validNotificationChange(scope, expectedVersion, kind, owner, actorRef)) return err({ kind: "invalidValue" });
    const observed = await this.read(scope);
    if (!observed.ok) return observed;
    if (observed.value.version !== expectedVersion) return err({ kind: "versionConflict" });
    if (owner !== null) {
      const ready = await resolveNotification(this.registry, scope, kind, owner);
      if (!ready.ok) return ready;
    }
    try {
      return await this.db.transaction().execute(async trx => {
        const key = ids(scope);
        await trx.insertInto("clinic_notification_settings").values({ ...key,
          version: 0 as ClinicNotificationSettingsVersion, owners: defaultNotificationSettings().owners })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "version"]).doNothing()).execute();
        // The public version-zero row is the clinic-wide lock, including edits at other locations/kinds.
        await trx.selectFrom("clinic_notification_settings").select("version")
          .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id)
          .where("version", "=", 0 as ClinicNotificationSettingsVersion).forUpdate().executeTakeFirstOrThrow();
        const previous = await trx.selectFrom("clinic_notification_settings").select(["version", "owners"])
          .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id)
          .orderBy("version", "desc").limit(1).executeTakeFirstOrThrow();
        const decoded = decode(previous.version, previous.owners);
        if (!decoded.ok) return decoded;
        if (decoded.value.version !== expectedVersion) return err({ kind: "versionConflict" });
        const version = previous.version + 1;
        const owners = { ...decoded.value.owners, [kind]: owner };
        await trx.insertInto("clinic_notification_settings").values({ ...key,
          version: version as ClinicNotificationSettingsVersion, owners, notification_kind: kind,
          owner, previous_owner: decoded.value.owners[kind], changed_by: actorRef, changed_at: sql`clock_timestamp()` }).execute();
        return ok({ version: String(version), owners });
      });
    } catch { return err({ kind: "storageFailure" }); }
  }
  async listChanges(scope: NotificationClinicScope, afterVersion?: number): Promise<Result<NotificationAuditPage, PolicyFailure>> {
    if (!validNotificationClinicScope(scope) || !validNotificationCursor(afterVersion)) return err({ kind: "invalidValue" });
    try {
      const key = ids(scope);
      const rows = await this.db.selectFrom("clinic_notification_settings")
        .select(["version", "notification_kind", "owner", "previous_owner", "changed_by", "changed_at"])
        .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id)
        .where("version", ">", (afterVersion ?? 0) as ClinicNotificationSettingsVersion)
        .orderBy("version", "asc").limit(50).execute();
      const entries: NotificationAuditEntry[] = [];
      for (const row of rows) {
        if (!validNotificationKind(row.notification_kind) || !validNotificationOwner(row.owner) ||
            !validNotificationOwner(row.previous_owner) || typeof row.changed_by !== "string" ||
            !row.changed_by.trim() || row.changed_by.length > 256 || !(row.changed_at instanceof Date) ||
            !Number.isFinite(row.changed_at.getTime())) return err({ kind: "storageFailure" });
        entries.push({ version: String(row.version), kind: row.notification_kind, owner: row.owner,
          previousOwner: row.previous_owner, actorRef: row.changed_by, changedAt: row.changed_at.toISOString() });
      }
      return ok({ entries, ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
    } catch { return err({ kind: "storageFailure" }); }
  }
}
