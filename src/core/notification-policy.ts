import { err, ok } from "./model.ts";
import type { CallPolicy, LocationScope, Result } from "./model.ts";
import type { PolicyFailure } from "./host.ts";
import type { ReadinessFailure } from "./readiness.ts";
import { systemTimer } from "./timer.ts";
import type { TimerPort } from "./timer.ts";

export const NOTIFICATION_KINDS = ["bookingConfirmation", "cancellationConfirmation", "reschedulingConfirmation"] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export type NotificationOwner = "host" | "abby";
export type NotificationClinicScope = Pick<LocationScope, "tenantId" | "clinicId">;
export type NotificationSettings = Readonly<{
  version: string;
  owners: Readonly<Record<NotificationKind, NotificationOwner | null>>;
}>;
export type NotificationBinding = Readonly<{
  scope: LocationScope;
  kind: NotificationKind;
  owner: NotificationOwner;
  settingsVersion: string;
  hostVersion: string;
}>;
export type NotificationDeclaration = Readonly<{
  scope: LocationScope;
  kind: NotificationKind;
  hostVersion: string;
  owners: readonly NotificationOwner[];
  /** All appointment-write paths suppress native auto-send; only the keyed dispatch port sends. */
  nativeDelivery: "managedOnly";
  ready: true;
}>;
export interface NotificationRegistry {
  resolve(scope: LocationScope, kind: NotificationKind, signal?: AbortSignal):
    Promise<Result<NotificationDeclaration, ReadinessFailure>>;
}
export type NotificationAuditEntry = Readonly<{
  version: string;
  kind: NotificationKind;
  owner: NotificationOwner | null;
  previousOwner: NotificationOwner | null;
  actorRef: string;
  changedAt: string;
}>;
export type NotificationAuditPage = Readonly<{
  entries: readonly NotificationAuditEntry[];
  nextAfterVersion?: number;
}>;
export interface ClinicNotificationSettingStore {
  read(scope: NotificationClinicScope): Promise<Result<NotificationSettings, PolicyFailure>>;
  changeOwner(scope: LocationScope, expectedVersion: string, kind: NotificationKind, owner: NotificationOwner | null,
    actorRef: string): Promise<Result<NotificationSettings, PolicyFailure>>;
  listChanges(scope: NotificationClinicScope, afterVersion?: number): Promise<Result<NotificationAuditPage, PolicyFailure>>;
}

const unready = (): Result<never, ReadinessFailure> => err({ kind: "readinessFailed", missing: ["notificationOwner"] });
export const unprovenNotificationRegistry: NotificationRegistry = { resolve: async () => unready() };

function record(value: unknown): Record<string, unknown> | undefined {
  return !!value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function ref(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}
export function validNotificationClinicScope(scope: NotificationClinicScope): boolean {
  return !!record(scope) && ref(scope.tenantId) && ref(scope.clinicId);
}
export function validNotificationLocationScope(scope: LocationScope): boolean {
  return validNotificationClinicScope(scope) && ref(scope.locationId);
}
export function validNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}
export function validNotificationOwner(value: unknown): value is NotificationOwner | null {
  return value === null || value === "host" || value === "abby";
}
export function validNotificationVersion(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && Number(value) <= 2_147_483_647;
}
export function validNotificationCursor(value: unknown): value is number | undefined {
  return value === undefined || Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;
}
export function defaultNotificationSettings(): NotificationSettings {
  return { version: "0", owners: { bookingConfirmation: null, cancellationConfirmation: null, reschedulingConfirmation: null } };
}
export function validNotificationSettings(value: unknown): value is NotificationSettings {
  const state = record(value);
  const owners = record(state?.owners);
  return !!state && Object.keys(state).sort().join(",") === "owners,version" && validNotificationVersion(state.version) &&
    !!owners && Object.keys(owners).sort().join(",") === [...NOTIFICATION_KINDS].sort().join(",") &&
    NOTIFICATION_KINDS.every(kind => validNotificationOwner(owners[kind]));
}
export function validNotificationChange(scope: LocationScope, version: string, kind: NotificationKind,
  owner: NotificationOwner | null, actorRef: string): boolean {
  return validNotificationLocationScope(scope) && validNotificationVersion(version) && Number(version) < 2_147_483_647 &&
    validNotificationKind(kind) && validNotificationOwner(owner) && ref(actorRef);
}
function validDeclaration(value: unknown, scope: LocationScope, kind: NotificationKind): value is NotificationDeclaration {
  const row = record(value);
  const bound = record(row?.scope);
  return !!row && Object.keys(row).sort().join(",") === "hostVersion,kind,nativeDelivery,owners,ready,scope" &&
    !!bound && Object.keys(bound).sort().join(",") === "clinicId,locationId,tenantId" &&
    bound.tenantId === scope.tenantId && bound.clinicId === scope.clinicId && bound.locationId === scope.locationId &&
    row.kind === kind && ref(row.hostVersion) && row.ready === true && row.nativeDelivery === "managedOnly" &&
    Array.isArray(row.owners) && row.owners.length > 0 && row.owners.length <= 2 &&
    new Set(row.owners).size === row.owners.length && row.owners.every(owner => owner === "host" || owner === "abby");
}

/** A registry is trusted host code, but its reply still needs exact scope and contract validation. */
export async function resolveNotification(registry: NotificationRegistry, scope: LocationScope, kind: NotificationKind,
  owner: NotificationOwner, timer: TimerPort = systemTimer): Promise<Result<NotificationDeclaration, ReadinessFailure>> {
  if (!validNotificationLocationScope(scope) || !validNotificationKind(kind) || owner !== "host" && owner !== "abby") return unready();
  const controller = new AbortController();
  let handle: unknown;
  try {
    const bound = structuredClone(scope);
    const timeout = new Promise<Result<never, ReadinessFailure>>(resolve => {
      handle = timer.schedule(() => { controller.abort(); resolve(unready()); }, 1_500);
    });
    const result = await Promise.race([Promise.resolve().then(() =>
      registry.resolve(structuredClone(bound), kind, controller.signal)), timeout]);
    return result.ok && validDeclaration(result.value, bound, kind) && result.value.owners.includes(owner)
      ? ok(structuredClone(result.value)) : unready();
  } catch { return unready(); }
  finally { if (handle !== undefined) timer.cancel(handle); }
}

/** Only this admission composition turns raw clinic preferences into current host authority. */
export async function captureNotificationPolicy(policy: CallPolicy, settings: NotificationSettings,
  registry: NotificationRegistry = unprovenNotificationRegistry): Promise<CallPolicy> {
  if (!validNotificationSettings(settings) || !validNotificationLocationScope(policy.scope)) throw new Error("invalid notification configuration");
  const { notificationSettings: _storedSettings, notificationBindings: _storedBindings, ...base } = structuredClone(policy);
  void _storedSettings; void _storedBindings;
  const captured = structuredClone(settings);
  const bindings: Partial<Record<NotificationKind, NotificationBinding>> = {};
  const rows = await Promise.all(NOTIFICATION_KINDS.map(async kind => {
    const owner = captured.owners[kind];
    if (owner === null) return undefined;
    const declaration = await resolveNotification(registry, base.scope, kind, owner);
    return declaration.ok ? { scope: structuredClone(base.scope), kind, owner,
      settingsVersion: captured.version, hostVersion: declaration.value.hostVersion } : undefined;
  }));
  for (const row of rows) if (row) bindings[row.kind] = row;
  return { ...base, notificationSettings: captured, notificationBindings: bindings };
}
