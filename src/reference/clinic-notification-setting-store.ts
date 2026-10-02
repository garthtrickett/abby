import { err, ok } from "../core/model.ts";
import type { Result, LocationScope } from "../core/model.ts";
import type { PolicyFailure } from "../core/host.ts";
import { defaultNotificationSettings, resolveNotification, unprovenNotificationRegistry, validNotificationChange,
  validNotificationClinicScope, validNotificationCursor } from "../core/notification-policy.ts";
import type { ClinicNotificationSettingStore, NotificationAuditEntry, NotificationAuditPage, NotificationClinicScope,
  NotificationKind, NotificationOwner, NotificationRegistry, NotificationSettings } from "../core/notification-policy.ts";

function clinicKey(scope: NotificationClinicScope): string { return JSON.stringify([scope.tenantId, scope.clinicId]); }

export class MemoryClinicNotificationSettingStore implements ClinicNotificationSettingStore {
  private readonly states = new Map<string, NotificationSettings>();
  private readonly histories = new Map<string, NotificationAuditEntry[]>();
  private readonly clock: () => string;
  private readonly registry: NotificationRegistry;
  constructor(clock: () => string = () => new Date().toISOString(), registry: NotificationRegistry = unprovenNotificationRegistry) {
    this.clock = clock;
    this.registry = registry;
  }
  current(scope: NotificationClinicScope): NotificationSettings {
    return structuredClone(this.states.get(clinicKey(scope)) ?? defaultNotificationSettings());
  }
  importSnapshot(scope: NotificationClinicScope, settings: NotificationSettings, history: readonly NotificationAuditEntry[]): void {
    const key = clinicKey(scope);
    if (this.states.has(key)) throw new Error("duplicate imported notification clinic");
    this.states.set(key, structuredClone(settings));
    this.histories.set(key, structuredClone([...history]));
  }
  async read(scope: NotificationClinicScope): Promise<Result<NotificationSettings, PolicyFailure>> {
    return validNotificationClinicScope(scope) ? ok(this.current(scope)) : err({ kind: "invalidValue" });
  }
  async changeOwner(scope: LocationScope, expectedVersion: string, kind: NotificationKind, owner: NotificationOwner | null,
    actorRef: string): Promise<Result<NotificationSettings, PolicyFailure>> {
    if (!validNotificationChange(scope, expectedVersion, kind, owner, actorRef)) return err({ kind: "invalidValue" });
    const key = clinicKey(scope);
    const previous = this.current(scope);
    if (previous.version !== expectedVersion) return err({ kind: "versionConflict" });
    if (owner !== null) {
      const ready = await resolveNotification(this.registry, scope, kind, owner);
      if (!ready.ok) return ready;
    }
    // Host preflight awaits; all kinds and locations compete on this one clinic version.
    if (this.current(scope).version !== expectedVersion) return err({ kind: "versionConflict" });
    let changedAt: string;
    try { changedAt = this.clock(); }
    catch { return err({ kind: "storageFailure" }); }
    if (typeof changedAt !== "string" || !Number.isFinite(Date.parse(changedAt))) return err({ kind: "storageFailure" });
    const next = { version: String(Number(expectedVersion) + 1), owners: { ...previous.owners, [kind]: owner } };
    this.states.set(key, next);
    const history = this.histories.get(key) ?? [];
    history.push({ version: next.version, kind, owner, previousOwner: previous.owners[kind], actorRef, changedAt });
    this.histories.set(key, history);
    return ok(structuredClone(next));
  }
  async listChanges(scope: NotificationClinicScope, afterVersion?: number): Promise<Result<NotificationAuditPage, PolicyFailure>> {
    if (!validNotificationClinicScope(scope) || !validNotificationCursor(afterVersion)) return err({ kind: "invalidValue" });
    const entries = (this.histories.get(clinicKey(scope)) ?? []).filter(row => Number(row.version) > (afterVersion ?? 0)).slice(0, 50);
    return ok({ entries: structuredClone(entries), ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
  }
}
