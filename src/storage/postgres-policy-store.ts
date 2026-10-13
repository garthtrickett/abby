import { PostgresClinicIntakeSettingStore } from "./postgres-clinic-intake-setting.ts";
import { PostgresClinicPatientCorrectionSettingStore } from "./postgres-clinic-patient-correction-setting.ts";
import type { ClinicPatientCorrectionState, ClinicPatientCorrectionAuditPage } from "../core/clinic-patient-correction-setting.ts";
import { PostgresClinicNotificationSettingStore } from "./postgres-clinic-notification-settings.ts";
import { PostgresClinicVoiceSettingStore } from "./postgres-clinic-voice-settings.ts";
import { captureVoicePolicy } from "../core/voice-policy.ts";
import { validVoiceLocationScope, voiceClinicScope } from "../core/voice-profile.ts";
import type { VoiceCatalogue, VoiceSettingKind } from "../core/voice-profile.ts";
import type { VoiceSettingAuditPage } from "../core/clinic-voice-setting.ts";
import { listVoiceOptions, unprovenVoiceProfileRegistry } from "../core/voice-profile-registry.ts";
import type { VoiceProfileRegistry } from "../core/voice-profile-registry.ts";
import { captureNotificationPolicy, listNotificationOptions, unprovenNotificationRegistry } from "../core/notification-policy.ts";
import type { NotificationAuditPage, NotificationCatalogue, NotificationKind, NotificationOwner, NotificationRegistry } from "../core/notification-policy.ts";
import type { ClinicIntakeAuditPage, ClinicIntakeState } from "../core/clinic-intake-setting.ts";
import { PostgresStaffedDestinationSettingStore } from "./postgres-staffed-destination-setting.ts";
import { captureStaffedDestination, listStaffedDestinations, unprovenStaffedDestinationRegistry, validStaffedDestinationRef } from "../core/staffed-destination.ts";
import type { StaffedDestinationAuditPage, StaffedDestinationCatalogue, StaffedDestinationRegistry } from "../core/staffed-destination.ts";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { AfterHoursSettingAuditEntry, AfterHoursSettingAuditPage, AutomationSettingAuditEntry, AutomationSettingAuditPage, BookingSettingAuditEntry, BookingSettingAuditPage, GreetingSettingAuditEntry, GreetingSettingAuditPage, StaffScheduleSettingAuditEntry, StaffScheduleSettingAuditPage, UrgentSettingAuditEntry, UrgentSettingAuditPage, PolicyFailure, PolicyStore } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { PatientSettingModes, AfterHoursMode, ApprovedAfterHoursInfo, ApprovedGreeting, ApprovedStaffSchedule, ApprovedUrgentResponse, CallPolicy, CapabilityMode, LocationScope, Result } from "../core/model.ts";
import { validAfterHoursSetting } from "../core/after-hours-policy.ts";
import { validGreetingShape } from "../core/greeting.ts";
import { validApprovedStaffSchedule } from "../core/staff-schedule.ts";
import { validUrgentResponseShape } from "../core/urgent-response.ts";
import { READINESS_REQUIREMENTS, unprovenReadiness } from "../core/readiness.ts";
import type { AutomationReadiness } from "../core/readiness.ts";
import type { CancellationSettingAuditEntry, CancellationSettingAuditPage, ReschedulingSettingAuditPage } from "../core/host.ts";
import type Database from "./generated/Database.ts";
import type { ClinicAutomationClinicId, ClinicAutomationTenantId, ClinicAutomationVersion } from "./generated/public/ClinicAutomation.ts";
import type { ClinicSettingsClinicId, ClinicSettingsLocationId, ClinicSettingsTenantId, ClinicSettingsVersion } from "./generated/public/ClinicSettings.ts";

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

type StoredStandalonePolicy = Readonly<{ scope: LocationScope; policyVersion: string; bookingEnabled: boolean; cancellationEnabled?: boolean; reschedulingEnabled?: boolean;
  afterHoursMode: AfterHoursMode; afterHoursInfo?: ApprovedAfterHoursInfo; urgentResponse?: ApprovedUrgentResponse;
  staffSchedule?: ApprovedStaffSchedule; greeting?: ApprovedGreeting | null; transferDestinationRef?: string }>;
const standaloneScopeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function validStandaloneScope(scope: LocationScope): boolean {
  return [scope.tenantId, scope.clinicId, scope.locationId].every(value => typeof value === "string" && standaloneScopeId.test(value));
}

function standalonePolicy(scope: LocationScope, version: number, bookingEnabled: boolean,
                          mode: AfterHoursMode = "staffRequest", info?: ApprovedAfterHoursInfo,
                          urgent?: ApprovedUrgentResponse, staffSchedule?: ApprovedStaffSchedule,
                          greeting?: ApprovedGreeting | null, cancellationEnabled?: boolean, reschedulingEnabled?: boolean,
                          transferDestinationRef?: string): StoredStandalonePolicy {
  return { scope: { tenantId: scope.tenantId, clinicId: scope.clinicId, locationId: scope.locationId },
    policyVersion: String(version), bookingEnabled, afterHoursMode: mode,
    ...(cancellationEnabled === undefined ? {} : { cancellationEnabled }),
    ...(reschedulingEnabled === undefined ? {} : { reschedulingEnabled }),
    ...(transferDestinationRef === undefined ? {} : { transferDestinationRef }),
    ...(info ? { afterHoursInfo: structuredClone(info) } : {}),
    ...(urgent ? { urgentResponse: structuredClone(urgent) } : {}),
    ...(staffSchedule ? { staffSchedule: structuredClone(staffSchedule) } : {}),
    ...(greeting === undefined ? {} : { greeting: greeting === null ? null : structuredClone(greeting) }) };
}

export function isStoredStandalonePolicy(value: unknown, scope: LocationScope, version: number): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const stored = value as Record<string, unknown>;
  const fields = new Set(["bookingEnabled", "cancellationEnabled", "reschedulingEnabled", "policyVersion", "scope", "afterHoursMode", "afterHoursInfo", "urgentResponse", "staffSchedule", "greeting", "transferDestinationRef"]);
  if (!["bookingEnabled", "policyVersion", "scope"].every(field => Object.hasOwn(stored, field)) ||
      Object.keys(stored).some(field => !fields.has(field)) ||
      typeof stored.bookingEnabled !== "boolean" || stored.policyVersion !== String(version) ||
      (stored.cancellationEnabled !== undefined && typeof stored.cancellationEnabled !== "boolean") ||
      (stored.reschedulingEnabled !== undefined && typeof stored.reschedulingEnabled !== "boolean") ||
      (stored.transferDestinationRef !== undefined && !validStaffedDestinationRef(stored.transferDestinationRef)) ||
      typeof stored.scope !== "object" || stored.scope === null || Array.isArray(stored.scope)) return false;
  const storedScope = stored.scope as Record<string, unknown>;
  if (Object.keys(storedScope).sort().join(",") !== "clinicId,locationId,tenantId" ||
      !sameScope(storedScope as LocationScope, scope)) return false;
  return validAfterHoursSetting(stored.afterHoursMode ?? "staffRequest", stored.afterHoursInfo, scope) &&
    (stored.urgentResponse === undefined || validUrgentResponseShape(stored.urgentResponse, scope)) &&
    (stored.staffSchedule === undefined || validApprovedStaffSchedule(stored.staffSchedule, scope)) &&
    (stored.greeting === undefined || stored.greeting === null || validGreetingShape(stored.greeting, scope));
}

function decodeStandalonePolicy(value: unknown, scope: LocationScope, version: number,
                                defaultPolicy: (scope: LocationScope) => CallPolicy): Result<CallPolicy, PolicyFailure> {
  if (!isStoredStandalonePolicy(value, scope, version)) return err({ kind: "storageFailure" });
  const stored = value as Record<string, unknown>;
  const base = defaultPolicy(scope);
  const { afterHoursInfo: defaultAfterHoursInfo, urgentResponse: defaultUrgentResponse,
    staffSchedule: defaultStaffSchedule, greeting: defaultGreeting, transferDestinationRef: defaultRoute,
    transferDestinationVersion: defaultRouteVersion, ...safeBase } = base;
  void defaultAfterHoursInfo; void defaultUrgentResponse; void defaultStaffSchedule;
  void defaultRoute; void defaultRouteVersion;
  return ok({ ...safeBase, scope: { ...scope }, policyVersion: String(version),
    bookingEnabled: stored.bookingEnabled as boolean, afterHoursMode: (stored.afterHoursMode ?? "staffRequest") as AfterHoursMode,
    cancellationEnabled: (stored.cancellationEnabled ?? false) as boolean,
    reschedulingEnabled: (stored.reschedulingEnabled ?? false) as boolean,
    ...(stored.transferDestinationRef === undefined ? {} : { transferDestinationRef: stored.transferDestinationRef as string }),
    ...(stored.afterHoursInfo ? { afterHoursInfo: stored.afterHoursInfo as ApprovedAfterHoursInfo } : {}),
    ...(stored.urgentResponse ? { urgentResponse: stored.urgentResponse as ApprovedUrgentResponse } : {}),
    ...(stored.staffSchedule ? { staffSchedule: stored.staffSchedule as ApprovedStaffSchedule } : {}),
    ...(stored.greeting === undefined && defaultGreeting ? { greeting: defaultGreeting } : {}),
    ...(stored.greeting && stored.greeting !== null ? { greeting: stored.greeting as ApprovedGreeting } : {}) });
}

function decodePolicy(value: unknown, scope: LocationScope, version: number): Result<CallPolicy, PolicyFailure> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return err({ kind: "storageFailure" });
  const policy = value as CallPolicy;
  if (Object.hasOwn(policy, "voiceSettings") || Object.hasOwn(policy, "voiceProfile")) return err({ kind: "storageFailure" });
  if (!policy.scope || !sameScope(policy.scope, scope) || policy.policyVersion !== String(version) ||
      (policy.automationEnabled !== undefined && typeof policy.automationEnabled !== "boolean") ||
      (policy.staffWorkEnabled !== undefined && typeof policy.staffWorkEnabled !== "boolean") ||
      typeof policy.bookingEnabled !== "boolean" || !policy.capabilities ||
      (policy.cancellationEnabled !== undefined && typeof policy.cancellationEnabled !== "boolean") ||
      (policy.reschedulingEnabled !== undefined && typeof policy.reschedulingEnabled !== "boolean") ||
      (policy.transferDestinationRef !== undefined && !validStaffedDestinationRef(policy.transferDestinationRef)) ||
      !validAfterHoursSetting(policy.afterHoursMode ?? "staffRequest", policy.afterHoursInfo, scope) ||
      (policy.urgentResponse !== undefined && !validUrgentResponseShape(policy.urgentResponse, scope)) ||
      (policy.staffSchedule !== undefined && !validApprovedStaffSchedule(policy.staffSchedule, scope)) ||
      (policy.greeting !== undefined && !validGreetingShape(policy.greeting, scope)) ||
      !["execute", "requestOnly", "unavailable"].includes(policy.capabilities.transfer) ||
      !policy.staffDestination || !policy.operatorQueue) return err({ kind: "storageFailure" });
  const { firstTimeIntakeEnabled, firstTimeIntakeVersion, patientCorrectionsEnabled, patientCorrectionsVersion, transferDestinationVersion, ...local } = policy;
  void firstTimeIntakeEnabled; void firstTimeIntakeVersion;
  void patientCorrectionsEnabled; void patientCorrectionsVersion;
  void transferDestinationVersion;
  return ok(structuredClone({ ...local, automationVersion: "0", automationEnabled: false }));
}

export class PostgresPolicyStore implements PolicyStore {
  private readonly db: Kysely<Database>;
  private readonly defaultPolicy: (scope: LocationScope) => CallPolicy;
  private readonly hostBookingMode: CapabilityMode;
  private readonly readiness: AutomationReadiness;
  private readonly staffWorkEnabled: boolean;
  private readonly storageMode: "unsafeReference" | "standaloneMinimal";
  private readonly allowDefaultGreeting: boolean;
  private readonly hostCancellationMode: CapabilityMode;
  private readonly hostReschedulingMode: CapabilityMode;
  private readonly hostIntakeMode: CapabilityMode;
  private readonly hostPatientUpdateMode: CapabilityMode;
  private readonly staffedDestinationRegistry: StaffedDestinationRegistry;
  private readonly notificationRegistry: NotificationRegistry;
  private readonly voiceRegistry: VoiceProfileRegistry;

  /** Rich policy storage is synthetic-only and requires the explicit unsafeReference mode. */
  constructor(db: Kysely<Database>, defaultPolicy: (scope: LocationScope) => CallPolicy, hostBookingMode: CapabilityMode = "unavailable", readiness: AutomationReadiness = unprovenReadiness,
              staffWorkEnabled = false, storageMode: "unsafeReference" | "standaloneMinimal" = "standaloneMinimal",
              allowDefaultGreeting = false, hostPatientModes: CapabilityMode | PatientSettingModes = "unavailable",
              staffedDestinationRegistry: StaffedDestinationRegistry = unprovenStaffedDestinationRegistry,
              notificationRegistry: NotificationRegistry = unprovenNotificationRegistry,
              voiceRegistry: VoiceProfileRegistry = unprovenVoiceProfileRegistry) {
    this.db = db;
    this.defaultPolicy = defaultPolicy;
    this.hostBookingMode = hostBookingMode;
    this.readiness = readiness;
    this.staffWorkEnabled = staffWorkEnabled;
    this.storageMode = storageMode;
    this.allowDefaultGreeting = allowDefaultGreeting;
    this.hostCancellationMode = typeof hostPatientModes === "string" ? hostPatientModes : hostPatientModes.cancellation ?? "unavailable";
    this.hostReschedulingMode = typeof hostPatientModes === "string" ? "unavailable" : hostPatientModes.rescheduling ?? "unavailable";
    this.hostIntakeMode = typeof hostPatientModes === "string" ? "unavailable" : hostPatientModes.intake ?? "unavailable";
    this.hostPatientUpdateMode = typeof hostPatientModes === "string" ? "unavailable" : hostPatientModes.patientUpdate ?? "unavailable";
    this.staffedDestinationRegistry = staffedDestinationRegistry;
    this.notificationRegistry = storageMode === "standaloneMinimal" ? unprovenNotificationRegistry : notificationRegistry;
    this.voiceRegistry = voiceRegistry;
  }

  private defaultFor(scope: LocationScope): CallPolicy {
    const { firstTimeIntakeEnabled, firstTimeIntakeVersion, patientCorrectionsEnabled, patientCorrectionsVersion, transferDestinationVersion,
      notificationSettings, notificationBindings, voiceSettings, voiceProfile, ...policy } = this.defaultPolicy(scope);
    void firstTimeIntakeEnabled; void firstTimeIntakeVersion;
    void patientCorrectionsEnabled; void patientCorrectionsVersion;
    void transferDestinationVersion;
    void notificationSettings; void notificationBindings;
    void voiceSettings; void voiceProfile;
    if (this.storageMode !== "standaloneMinimal" || this.allowDefaultGreeting) return policy;
    const { greeting, ...safe } = policy;
    void greeting;
    return safe;
  }

  private decode(value: unknown, scope: LocationScope, version: number): Result<CallPolicy, PolicyFailure> {
    return this.storageMode === "standaloneMinimal"
      ? decodeStandalonePolicy(value, scope, version, scope => this.defaultFor(scope)) : decodePolicy(value, scope, version);
  }

  private compose(policy: CallPolicy, intake: ClinicIntakeState, corrections: ClinicPatientCorrectionState, automation?: Readonly<{ version: number; enabled: boolean }>): CallPolicy {
    const patientModes = this.hostBookingMode === "unavailable"
      ? { cancel: "unavailable", reschedule: "unavailable", intake: "unavailable" } as const : {};
    return { ...policy, cancellationEnabled: policy.cancellationEnabled ?? false, reschedulingEnabled: policy.reschedulingEnabled ?? false,
      afterHoursMode: policy.afterHoursMode ?? "staffRequest", staffWorkEnabled: this.staffWorkEnabled,
      automationVersion: String(automation?.version ?? 0), automationEnabled: automation?.enabled ?? false,
      firstTimeIntakeVersion: intake.version, firstTimeIntakeEnabled: intake.enabled,
      patientCorrectionsVersion: corrections.version, patientCorrectionsEnabled: corrections.enabled,
      capabilities: { ...policy.capabilities, ...patientModes,
        book: policy.bookingEnabled ? this.hostBookingMode : "unavailable",
        cancel: policy.cancellationEnabled === true && this.storageMode === "unsafeReference"
          ? this.hostCancellationMode : "unavailable",
        reschedule: policy.reschedulingEnabled === true && this.storageMode === "unsafeReference"
          ? this.hostReschedulingMode : "unavailable",
        intake: intake.enabled && this.storageMode === "unsafeReference" ? this.hostIntakeMode : "unavailable",
        ...(corrections.version !== "0" || this.hostPatientUpdateMode !== "unavailable" || policy.capabilities.patientUpdate !== undefined
          ? { patientUpdate: corrections.enabled && this.storageMode === "unsafeReference" ? this.hostPatientUpdateMode : "unavailable" } : {}),
        transfer: this.staffWorkEnabled ? policy.capabilities.transfer : "unavailable" } };
  }

  private async capture(policy: CallPolicy, automation?: Readonly<{ version: number; enabled: boolean }>,
                        db: Kysely<Database> = this.db): Promise<CallPolicy> {
    const intake = await new PostgresClinicIntakeSettingStore(db).read(policy.scope);
    if (!intake.ok) throw new Error("clinic intake configuration unavailable");
    const corrections = await new PostgresClinicPatientCorrectionSettingStore(db).read(policy.scope);
    if (!corrections.ok) throw new Error("clinic correction configuration unavailable");
    const notifications = await new PostgresClinicNotificationSettingStore(db).read(policy.scope);
    if (!notifications.ok) throw new Error("clinic notification configuration unavailable");
    const voice = await new PostgresClinicVoiceSettingStore(db).read(voiceClinicScope(policy.scope));
    if (!voice.ok) throw new Error("clinic voice configuration unavailable");
    const captured = await captureVoicePolicy(await captureNotificationPolicy(this.compose(policy, intake.value, corrections.value, automation),
      notifications.value, this.notificationRegistry), voice.value, this.voiceRegistry);
    if (!captured.ok) throw new Error("clinic voice profile unavailable");
    const composed = captured.value;
    if (this.storageMode === "standaloneMinimal" || !this.staffWorkEnabled) {
      const { transferDestinationVersion, ...safe } = composed;
      void transferDestinationVersion;
      return { ...safe, capabilities: { ...safe.capabilities, transfer: "unavailable" } };
    }
    return captureStaffedDestination(composed, (bound, ref) => this.staffedDestinationRegistry.resolve(bound, ref));
  }

  private staffedDestinationSettings(): PostgresStaffedDestinationSettingStore {
    return new PostgresStaffedDestinationSettingStore(this.db, {
      initial: scope => ({ ...this.defaultFor(scope), policyVersion: "0" }),
      decode: (value, scope, version) => this.decode(value, scope, version),
      encode: policy => this.storageMode === "standaloneMinimal"
        ? standalonePolicy(policy.scope, Number(policy.policyVersion), policy.bookingEnabled,
          policy.afterHoursMode ?? "staffRequest", policy.afterHoursInfo, policy.urgentResponse, policy.staffSchedule,
          policy.greeting ?? null, policy.cancellationEnabled, policy.reschedulingEnabled, policy.transferDestinationRef) : policy,
    }, (bound, ref) => this.staffedDestinationRegistry.resolve(bound, ref));
  }

  async changeVoiceSetting(scope: LocationScope, expectedVersion: string, kind: VoiceSettingKind,
    value: string | null, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (!validVoiceLocationScope(scope) || this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope)) return err({ kind: "invalidValue" });
    const bound = structuredClone(scope);
    const changed = await new PostgresClinicVoiceSettingStore(this.db, this.voiceRegistry)
      .change(voiceClinicScope(bound), expectedVersion, kind, value, actorRef);
    return changed.ok ? this.read(bound) : changed;
  }
  async listVoiceOptions(scope: LocationScope): Promise<Result<VoiceCatalogue, PolicyFailure>> {
    if (!validVoiceLocationScope(scope) || this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope)) return err({ kind: "invalidValue" });
    return listVoiceOptions(this.voiceRegistry, voiceClinicScope(scope));
  }
  async listVoiceChanges(scope: LocationScope, afterVersion?: number): Promise<Result<VoiceSettingAuditPage, PolicyFailure>> {
    if (!validVoiceLocationScope(scope) || this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope)) return err({ kind: "invalidValue" });
    return new PostgresClinicVoiceSettingStore(this.db).listChanges(voiceClinicScope(scope), afterVersion);
  }

  async changeNotificationOwner(scope: LocationScope, expectedVersion: string, kind: NotificationKind,
    owner: NotificationOwner | null, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope)) return err({ kind: "invalidValue" });
    const changed = await new PostgresClinicNotificationSettingStore(this.db, this.notificationRegistry)
      .changeOwner(scope, expectedVersion, kind, owner, actorRef);
    return changed.ok ? this.read(scope) : changed;
  }
  async listNotificationOptions(scope: LocationScope): Promise<Result<NotificationCatalogue, PolicyFailure>> {
    if (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope)) return err({ kind: "invalidValue" });
    return listNotificationOptions(this.notificationRegistry, scope);
  }
  async listNotificationChanges(scope: LocationScope, afterVersion?: number): Promise<Result<NotificationAuditPage, PolicyFailure>> {
    if (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope)) return err({ kind: "invalidValue" });
    return new PostgresClinicNotificationSettingStore(this.db).listChanges(scope, afterVersion);
  }

  async listStaffedDestinations(scope: LocationScope): Promise<Result<StaffedDestinationCatalogue, PolicyFailure>> {
    if (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope)) return err({ kind: "invalidValue" });
    return listStaffedDestinations(this.staffedDestinationRegistry, scope);
  }

  async changeStaffedDestination(scope: LocationScope, expectedVersion: string, destinationRef: string | null,
                                actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope)) return err({ kind: "invalidValue" });
    const changed = await this.staffedDestinationSettings().change(scope, expectedVersion, destinationRef, actorRef);
    return changed.ok ? this.read(scope) : changed;
  }

  async listStaffedDestinationChanges(scope: LocationScope, afterVersion?: number): Promise<Result<StaffedDestinationAuditPage, PolicyFailure>> {
    if (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope)) return err({ kind: "invalidValue" });
    return this.staffedDestinationSettings().listChanges(scope, afterVersion);
  }

  async read(scope: LocationScope): Promise<Result<CallPolicy, PolicyFailure>> {
    if (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope)) return err({ kind: "invalidValue" });
    try {
      const local = this.db.selectFrom("clinic_settings").select(["version", "policy"])
        .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
        .where("location_id", "=", scope.locationId as ClinicSettingsLocationId)
        .orderBy("version", "desc").limit(1).executeTakeFirst();
      const clinic = this.db.selectFrom("clinic_automation").select(["version", "enabled"])
        .where("tenant_id", "=", scope.tenantId as ClinicAutomationTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicAutomationClinicId)
        .orderBy("version", "desc").limit(1).executeTakeFirst();
      const [row, automation] = await Promise.all([local, clinic]);
      const decoded = row ? this.decode(row.policy, scope, row.version) : ok(this.defaultFor(scope));
      return decoded.ok ? ok(await this.capture(decoded.value, automation)) : decoded;
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async changeAutomationEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (typeof enabled !== "boolean" || typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256 ||
        (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope))) return err({ kind: "invalidValue" });
    try {
      const current = await this.db.selectFrom("clinic_automation").select("version")
        .where("tenant_id", "=", scope.tenantId as ClinicAutomationTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicAutomationClinicId)
        .orderBy("version", "desc").limit(1).executeTakeFirst();
      if (String(current?.version ?? 0) !== expectedVersion) return err({ kind: "versionConflict" });
    } catch { return err({ kind: "storageFailure" }); }
    if (enabled) {
      let ready: Awaited<ReturnType<AutomationReadiness>>;
      try { ready = await this.readiness(scope); }
      catch { return err({ kind: "readinessFailed", missing: READINESS_REQUIREMENTS }); }
      if (!ready.ok) return ready;
      if (ready.value !== true) return err({ kind: "readinessFailed", missing: READINESS_REQUIREMENTS });
    }
    try {
      return await this.db.transaction().execute(async trx => {
        const ids = {
          tenant_id: scope.tenantId as ClinicAutomationTenantId,
          clinic_id: scope.clinicId as ClinicAutomationClinicId,
        };
        await trx.insertInto("clinic_automation").values({ ...ids, version: 0 as ClinicAutomationVersion, enabled: false })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "version"]).doNothing()).execute();
        await trx.selectFrom("clinic_automation").select("version")
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id)
          .where("version", "=", 0 as ClinicAutomationVersion).forUpdate().executeTakeFirstOrThrow();
        const latest = await trx.selectFrom("clinic_automation").select(["version", "enabled"])
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id)
          .orderBy("version", "desc").limit(1).executeTakeFirstOrThrow();
        if (String(latest.version) !== expectedVersion) return err({ kind: "versionConflict" });
        const local = await trx.selectFrom("clinic_settings").select(["version", "policy"])
          .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId)
          .where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
          .where("location_id", "=", scope.locationId as ClinicSettingsLocationId)
          .orderBy("version", "desc").limit(1).executeTakeFirst();
        const decoded = local ? this.decode(local.policy, scope, local.version) : ok(this.defaultFor(scope));
        if (!decoded.ok) throw new Error("invalid location policy");
        await trx.insertInto("clinic_automation").values({ ...ids, version: latest.version + 1 as ClinicAutomationVersion,
          enabled, changed_by: actorRef, previous_enabled: latest.enabled, changed_at: sql`clock_timestamp()` }).execute();
        return ok(await this.capture(decoded.value, { version: latest.version + 1, enabled }, trx));
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async listAutomationChanges(scope: LocationScope, afterVersion?: number): Promise<Result<AutomationSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    try {
      const rows = await this.db.selectFrom("clinic_automation")
        .select(["version", "enabled", "changed_by", "previous_enabled", "changed_at"])
        .where("tenant_id", "=", scope.tenantId as ClinicAutomationTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicAutomationClinicId)
        .where("version", ">", (afterVersion ?? 0) as ClinicAutomationVersion)
        .orderBy("version", "asc").limit(50).execute();
      const entries: AutomationSettingAuditEntry[] = [];
      for (const row of rows) {
        if (typeof row.changed_by !== "string" || !row.changed_by.trim() || typeof row.previous_enabled !== "boolean" ||
            !(row.changed_at instanceof Date) || !Number.isFinite(row.changed_at.getTime())) return err({ kind: "storageFailure" });
        entries.push({ version: String(row.version), enabled: row.enabled,
          previousEnabled: row.previous_enabled, actorRef: row.changed_by, changedAt: row.changed_at.toISOString() });
      }
      return ok({ entries, ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async changeFirstTimeIntakeEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean,
                                   actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope)) return err({ kind: "invalidValue" });
    const changed = await new PostgresClinicIntakeSettingStore(this.db).changeEnabled(scope, expectedVersion, enabled, actorRef);
    return changed.ok ? this.read(scope) : changed;
  }

  async listFirstTimeIntakeChanges(scope: LocationScope, afterVersion?: number): Promise<Result<ClinicIntakeAuditPage, PolicyFailure>> {
    if (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope)) return err({ kind: "invalidValue" });
    return new PostgresClinicIntakeSettingStore(this.db).listChanges(scope, afterVersion);
  }

  async changePatientCorrectionsEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean,
                                       actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope)) return err({ kind: "invalidValue" });
    const changed = await new PostgresClinicPatientCorrectionSettingStore(this.db).changeEnabled(scope, expectedVersion, enabled, actorRef);
    return changed.ok ? this.read(scope) : changed;
  }
  async listPatientCorrectionChanges(scope: LocationScope, afterVersion?: number): Promise<Result<ClinicPatientCorrectionAuditPage, PolicyFailure>> {
    if (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope)) return err({ kind: "invalidValue" });
    return new PostgresClinicPatientCorrectionSettingStore(this.db).listChanges(scope, afterVersion);
  }

  async changeBookingEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (typeof enabled !== "boolean" || typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256 ||
        (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope))) return err({ kind: "invalidValue" });
    try {
      return await this.db.transaction().execute(async trx => {
        const ids = {
          tenant_id: scope.tenantId as ClinicSettingsTenantId,
          clinic_id: scope.clinicId as ClinicSettingsClinicId,
          location_id: scope.locationId as ClinicSettingsLocationId,
        };
        const initialPolicy = this.defaultFor(scope);
        await trx.insertInto("clinic_settings").values({ ...ids, version: 0 as ClinicSettingsVersion,
          policy: this.storageMode === "standaloneMinimal" ? standalonePolicy(scope, 0, initialPolicy.bookingEnabled, "staffRequest", undefined, undefined, undefined,
                initialPolicy.greeting ?? null, initialPolicy.cancellationEnabled, initialPolicy.reschedulingEnabled, initialPolicy.transferDestinationRef) : initialPolicy })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "location_id", "version"]).doNothing()).execute();
        await trx.selectFrom("clinic_settings").select("version")
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).where("location_id", "=", ids.location_id)
          .where("version", "=", 0 as ClinicSettingsVersion).forUpdate().executeTakeFirstOrThrow();
        const latest = await trx.selectFrom("clinic_settings").select(["version", "policy"])
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).where("location_id", "=", ids.location_id)
          .orderBy("version", "desc").limit(1).executeTakeFirstOrThrow();
        const decoded = this.decode(latest.policy, scope, latest.version);
        if (!decoded.ok) return decoded;
        if (decoded.value.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
        const next: CallPolicy = {
          ...decoded.value,
          policyVersion: String(latest.version + 1),
          bookingEnabled: enabled,
          capabilities: { ...decoded.value.capabilities, book: enabled ? this.hostBookingMode : "unavailable" },
        };
        await trx.insertInto("clinic_settings").values({ ...ids, version: latest.version + 1 as ClinicSettingsVersion,
          policy: this.storageMode === "standaloneMinimal" ? standalonePolicy(scope, latest.version + 1, enabled,
            next.afterHoursMode ?? "staffRequest", next.afterHoursInfo, next.urgentResponse, next.staffSchedule,
            next.greeting ?? null, next.cancellationEnabled, next.reschedulingEnabled, next.transferDestinationRef) : next,
          changed_by: actorRef, previous_booking_enabled: decoded.value.bookingEnabled, changed_at: sql`clock_timestamp()` }).execute();
        const automation = await trx.selectFrom("clinic_automation").select(["version", "enabled"])
          .where("tenant_id", "=", scope.tenantId as ClinicAutomationTenantId)
          .where("clinic_id", "=", scope.clinicId as ClinicAutomationClinicId)
          .orderBy("version", "desc").limit(1).executeTakeFirst();
        return ok(await this.capture(next, automation, trx));
      });
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async listBookingChanges(scope: LocationScope, afterVersion?: number): Promise<Result<BookingSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    try {
      const rows = await this.db.selectFrom("clinic_settings")
        .select(["version", "policy", "changed_by", "previous_booking_enabled", "changed_at"])
        .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
        .where("location_id", "=", scope.locationId as ClinicSettingsLocationId)
        .where("setting_kind", "=", "booking")
        .where("version", ">", (afterVersion ?? 0) as ClinicSettingsVersion)
        .orderBy("version", "asc").limit(50).execute();
      const entries: BookingSettingAuditEntry[] = [];
      for (const row of rows) {
        const decoded = this.decode(row.policy, scope, row.version);
        if (!decoded.ok) return decoded;
        const metadata = [row.changed_by, row.previous_booking_enabled, row.changed_at];
        if (metadata.every(value => value === null)) {
          entries.push({ version: String(row.version), enabled: decoded.value.bookingEnabled, provenance: "legacyUnattributed" });
          continue;
        }
        if (typeof row.changed_by !== "string" || !row.changed_by.trim() || typeof row.previous_booking_enabled !== "boolean" ||
            !(row.changed_at instanceof Date) || !Number.isFinite(row.changed_at.getTime())) return err({ kind: "storageFailure" });
        entries.push({ version: String(row.version), enabled: decoded.value.bookingEnabled, provenance: "recorded",
          actorRef: row.changed_by, previousEnabled: row.previous_booking_enabled, changedAt: row.changed_at.toISOString() });
      }
      return ok({ entries, ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async changeCancellationEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    return this.changeAppointmentEnabled("cancellation", scope, expectedVersion, enabled, actorRef);
  }

  async changeReschedulingEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    return this.changeAppointmentEnabled("rescheduling", scope, expectedVersion, enabled, actorRef);
  }

  async listCancellationChanges(scope: LocationScope, afterVersion?: number): Promise<Result<CancellationSettingAuditPage, PolicyFailure>> {
    return this.listAppointmentChanges("cancellation", scope, afterVersion);
  }

  async listReschedulingChanges(scope: LocationScope, afterVersion?: number): Promise<Result<ReschedulingSettingAuditPage, PolicyFailure>> {
    return this.listAppointmentChanges("rescheduling", scope, afterVersion);
  }

  private async changeAppointmentEnabled(setting: "cancellation" | "rescheduling", scope: LocationScope,
                                         expectedVersion: string, enabled: boolean, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (typeof enabled !== "boolean" || typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256 ||
        (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope))) return err({ kind: "invalidValue" });
    const field = setting === "cancellation" ? "cancellationEnabled" : "reschedulingEnabled";
    try {
      return await this.db.transaction().execute(async trx => {
        const ids = { tenant_id: scope.tenantId as ClinicSettingsTenantId,
          clinic_id: scope.clinicId as ClinicSettingsClinicId, location_id: scope.locationId as ClinicSettingsLocationId };
        const initial = this.defaultFor(scope);
        await trx.insertInto("clinic_settings").values({ ...ids, version: 0 as ClinicSettingsVersion,
          policy: this.storageMode === "standaloneMinimal"
            ? standalonePolicy(scope, 0, initial.bookingEnabled, "staffRequest", undefined, undefined, undefined,
              initial.greeting ?? null, initial.cancellationEnabled, initial.reschedulingEnabled, initial.transferDestinationRef) : initial })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "location_id", "version"]).doNothing()).execute();
        await trx.selectFrom("clinic_settings").select("version")
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).where("location_id", "=", ids.location_id)
          .where("version", "=", 0 as ClinicSettingsVersion).forUpdate().executeTakeFirstOrThrow();
        const latest = await trx.selectFrom("clinic_settings").select(["version", "policy"])
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).where("location_id", "=", ids.location_id)
          .orderBy("version", "desc").limit(1).executeTakeFirstOrThrow();
        const decoded = this.decode(latest.policy, scope, latest.version);
        if (!decoded.ok) return decoded;
        if (decoded.value.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
        const capability = setting === "cancellation" ? "cancel" : "reschedule";
        const hostMode = setting === "cancellation" ? this.hostCancellationMode : this.hostReschedulingMode;
        const next: CallPolicy = { ...decoded.value, policyVersion: String(latest.version + 1), [field]: enabled,
          capabilities: { ...decoded.value.capabilities, [capability]: enabled && this.storageMode === "unsafeReference"
            ? hostMode : "unavailable" } };
        await trx.insertInto("clinic_settings").values({ ...ids, version: latest.version + 1 as ClinicSettingsVersion,
          policy: this.storageMode === "standaloneMinimal"
            ? standalonePolicy(scope, latest.version + 1, next.bookingEnabled, next.afterHoursMode ?? "staffRequest",
              next.afterHoursInfo, next.urgentResponse, next.staffSchedule, next.greeting ?? null, next.cancellationEnabled, next.reschedulingEnabled, next.transferDestinationRef) : next,
          setting_kind: setting,
          ...(setting === "cancellation"
            ? { previous_cancellation_enabled: decoded.value.cancellationEnabled ?? false }
            : { previous_rescheduling_enabled: decoded.value.reschedulingEnabled ?? false }),
          changed_by: actorRef, changed_at: sql`clock_timestamp()` }).execute();
        const automation = await trx.selectFrom("clinic_automation").select(["version", "enabled"])
          .where("tenant_id", "=", scope.tenantId as ClinicAutomationTenantId)
          .where("clinic_id", "=", scope.clinicId as ClinicAutomationClinicId)
          .orderBy("version", "desc").limit(1).executeTakeFirst();
        return ok(await this.capture(next, automation, trx));
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  private async listAppointmentChanges(setting: "cancellation" | "rescheduling", scope: LocationScope, afterVersion?: number): Promise<Result<CancellationSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    const field = setting === "cancellation" ? "cancellationEnabled" : "reschedulingEnabled";
    const previousField = setting === "cancellation" ? "previous_cancellation_enabled" : "previous_rescheduling_enabled";
    try {
      const rows = await this.db.selectFrom("clinic_settings")
        .select(["version", "policy", "changed_by", "previous_cancellation_enabled", "previous_rescheduling_enabled", "changed_at"])
        .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
        .where("location_id", "=", scope.locationId as ClinicSettingsLocationId)
        .where("setting_kind", "=", setting)
        .where("version", ">", (afterVersion ?? 0) as ClinicSettingsVersion)
        .orderBy("version", "asc").limit(50).execute();
      const entries: CancellationSettingAuditEntry[] = [];
      for (const row of rows) {
        const decoded = this.decode(row.policy, scope, row.version);
        if (!decoded.ok) return decoded;
        if (typeof row.changed_by !== "string" || !row.changed_by.trim() ||
            typeof row[previousField] !== "boolean" ||
            !(row.changed_at instanceof Date) || !Number.isFinite(row.changed_at.getTime())) return err({ kind: "storageFailure" });
        entries.push({ version: String(row.version), enabled: decoded.value[field] ?? false,
          previousEnabled: row[previousField], actorRef: row.changed_by, changedAt: row.changed_at.toISOString() });
      }
      return ok({ entries, ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async changeAfterHours(scope: LocationScope, expectedVersion: string, mode: AfterHoursMode,
                         info: ApprovedAfterHoursInfo | undefined, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (!validAfterHoursSetting(mode, info, scope) || typeof actorRef !== "string" || !actorRef.trim() ||
        actorRef.length > 256 || (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope))) {
      return err({ kind: "invalidValue" });
    }
    try {
      return await this.db.transaction().execute(async trx => {
        const ids = { tenant_id: scope.tenantId as ClinicSettingsTenantId,
          clinic_id: scope.clinicId as ClinicSettingsClinicId,
          location_id: scope.locationId as ClinicSettingsLocationId };
        const initialPolicy = this.defaultFor(scope);
        await trx.insertInto("clinic_settings").values({ ...ids, version: 0 as ClinicSettingsVersion,
          policy: this.storageMode === "standaloneMinimal"
            ? standalonePolicy(scope, 0, initialPolicy.bookingEnabled, "staffRequest", undefined, undefined, undefined,
                initialPolicy.greeting ?? null, initialPolicy.cancellationEnabled, initialPolicy.reschedulingEnabled, initialPolicy.transferDestinationRef) : initialPolicy })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "location_id", "version"]).doNothing()).execute();
        await trx.selectFrom("clinic_settings").select("version")
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id)
          .where("location_id", "=", ids.location_id).where("version", "=", 0 as ClinicSettingsVersion)
          .forUpdate().executeTakeFirstOrThrow();
        const latest = await trx.selectFrom("clinic_settings").select(["version", "policy"])
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id)
          .where("location_id", "=", ids.location_id).orderBy("version", "desc").limit(1).executeTakeFirstOrThrow();
        const decoded = this.decode(latest.policy, scope, latest.version);
        if (!decoded.ok) return decoded;
        if (decoded.value.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
        const { afterHoursInfo: previousInfo, ...base } = decoded.value;
        void previousInfo;
        const next: CallPolicy = { ...base, policyVersion: String(latest.version + 1),
          afterHoursMode: mode,
          ...(mode === "approvedInfoAndRequest" ? { afterHoursInfo: structuredClone(info!) } : {}) };
        await trx.insertInto("clinic_settings").values({ ...ids,
          version: latest.version + 1 as ClinicSettingsVersion,
          policy: this.storageMode === "standaloneMinimal"
            ? standalonePolicy(scope, latest.version + 1, next.bookingEnabled, mode, next.afterHoursInfo, next.urgentResponse,
              next.staffSchedule, next.greeting ?? null, next.cancellationEnabled, next.reschedulingEnabled, next.transferDestinationRef) : next,
          setting_kind: "afterHours", previous_after_hours_mode: decoded.value.afterHoursMode ?? "staffRequest",
          changed_by: actorRef, changed_at: sql`clock_timestamp()` }).execute();
        const automation = await trx.selectFrom("clinic_automation").select(["version", "enabled"])
          .where("tenant_id", "=", scope.tenantId as ClinicAutomationTenantId)
          .where("clinic_id", "=", scope.clinicId as ClinicAutomationClinicId)
          .orderBy("version", "desc").limit(1).executeTakeFirst();
        return ok(await this.capture(next, automation, trx));
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async listAfterHoursChanges(scope: LocationScope, afterVersion?: number): Promise<Result<AfterHoursSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    try {
      const rows = await this.db.selectFrom("clinic_settings")
        .select(["version", "policy", "previous_after_hours_mode", "changed_by", "changed_at"])
        .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
        .where("location_id", "=", scope.locationId as ClinicSettingsLocationId)
        .where("setting_kind", "=", "afterHours")
        .where("version", ">", (afterVersion ?? 0) as ClinicSettingsVersion)
        .orderBy("version", "asc").limit(50).execute();
      const entries: AfterHoursSettingAuditEntry[] = [];
      for (const row of rows) {
        const decoded = this.decode(row.policy, scope, row.version);
        if (!decoded.ok) return decoded;
        if ((row.previous_after_hours_mode !== "staffRequest" && row.previous_after_hours_mode !== "approvedInfoAndRequest") ||
            typeof row.changed_by !== "string" || !row.changed_by.trim() ||
            !(row.changed_at instanceof Date) || !Number.isFinite(row.changed_at.getTime())) return err({ kind: "storageFailure" });
        entries.push({ version: String(row.version), mode: decoded.value.afterHoursMode ?? "staffRequest",
          previousMode: row.previous_after_hours_mode,
          ...(decoded.value.afterHoursInfo ? { infoVersion: decoded.value.afterHoursInfo.version } : {}),
          actorRef: row.changed_by, changedAt: row.changed_at.toISOString() });
      }
      return ok({ entries, ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async changeUrgentResponse(scope: LocationScope, expectedVersion: string,
                             response: ApprovedUrgentResponse | undefined, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if ((response !== undefined && (!validUrgentResponseShape(response, scope) || response.ownerRef !== actorRef)) ||
        typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256 ||
        (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope))) return err({ kind: "invalidValue" });
    try {
      return await this.db.transaction().execute(async trx => {
        const ids = { tenant_id: scope.tenantId as ClinicSettingsTenantId,
          clinic_id: scope.clinicId as ClinicSettingsClinicId,
          location_id: scope.locationId as ClinicSettingsLocationId };
        const initialPolicy = this.defaultFor(scope);
        await trx.insertInto("clinic_settings").values({ ...ids, version: 0 as ClinicSettingsVersion,
          policy: this.storageMode === "standaloneMinimal"
            ? standalonePolicy(scope, 0, initialPolicy.bookingEnabled, "staffRequest", undefined, undefined, undefined,
                initialPolicy.greeting ?? null, initialPolicy.cancellationEnabled, initialPolicy.reschedulingEnabled, initialPolicy.transferDestinationRef) : initialPolicy })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "location_id", "version"]).doNothing()).execute();
        await trx.selectFrom("clinic_settings").select("version")
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id)
          .where("location_id", "=", ids.location_id).where("version", "=", 0 as ClinicSettingsVersion)
          .forUpdate().executeTakeFirstOrThrow();
        const latest = await trx.selectFrom("clinic_settings").select(["version", "policy"])
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id)
          .where("location_id", "=", ids.location_id).orderBy("version", "desc").limit(1).executeTakeFirstOrThrow();
        const decoded = this.decode(latest.policy, scope, latest.version);
        if (!decoded.ok) return decoded;
        if (decoded.value.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
        const { urgentResponse: previousResponse, ...base } = decoded.value;
        void previousResponse;
        const next: CallPolicy = { ...base, policyVersion: String(latest.version + 1),
          ...(response === undefined ? {} : { urgentResponse: structuredClone(response) }) };
        await trx.insertInto("clinic_settings").values({ ...ids,
          version: latest.version + 1 as ClinicSettingsVersion,
          policy: this.storageMode === "standaloneMinimal"
            ? standalonePolicy(scope, latest.version + 1, next.bookingEnabled,
              next.afterHoursMode ?? "staffRequest", next.afterHoursInfo, next.urgentResponse, next.staffSchedule,
              next.greeting ?? null, next.cancellationEnabled, next.reschedulingEnabled, next.transferDestinationRef) : next,
          setting_kind: "urgent", changed_by: actorRef, changed_at: sql`clock_timestamp()` }).execute();
        const automation = await trx.selectFrom("clinic_automation").select(["version", "enabled"])
          .where("tenant_id", "=", scope.tenantId as ClinicAutomationTenantId)
          .where("clinic_id", "=", scope.clinicId as ClinicAutomationClinicId)
          .orderBy("version", "desc").limit(1).executeTakeFirst();
        return ok(await this.capture(next, automation, trx));
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async listUrgentResponseChanges(scope: LocationScope, afterVersion?: number): Promise<Result<UrgentSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    try {
      const rows = await this.db.selectFrom("clinic_settings")
        .select(["version", "policy", "changed_by", "changed_at"])
        .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
        .where("location_id", "=", scope.locationId as ClinicSettingsLocationId)
        .where("setting_kind", "=", "urgent")
        .where("version", ">", (afterVersion ?? 0) as ClinicSettingsVersion)
        .orderBy("version", "asc").limit(50).execute();
      const previousRows = rows.length ? await this.db.selectFrom("clinic_settings").select(["version", "policy"])
        .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
        .where("location_id", "=", scope.locationId as ClinicSettingsLocationId)
        .where("version", "in", rows.map(row => row.version - 1 as ClinicSettingsVersion)).execute() : [];
      const previous = new Map(previousRows.map(row => [row.version, row.policy]));
      const entries: UrgentSettingAuditEntry[] = [];
      for (const row of rows) {
        const current = this.decode(row.policy, scope, row.version);
        const before = this.decode(previous.get(row.version - 1 as ClinicSettingsVersion), scope, row.version - 1);
        if (!current.ok) return current;
        if (!before.ok) return before;
        if (typeof row.changed_by !== "string" || !row.changed_by.trim() ||
            !(row.changed_at instanceof Date) || !Number.isFinite(row.changed_at.getTime())) return err({ kind: "storageFailure" });
        entries.push({ version: String(row.version), enabled: current.value.urgentResponse !== undefined,
          previousEnabled: before.value.urgentResponse !== undefined,
          ...(current.value.urgentResponse ? { scriptVersion: current.value.urgentResponse.version } : {}),
          actorRef: row.changed_by, changedAt: row.changed_at.toISOString() });
      }
      return ok({ entries, ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async changeStaffSchedule(scope: LocationScope, expectedVersion: string,
                            schedule: ApprovedStaffSchedule | undefined, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if ((schedule !== undefined && (!validApprovedStaffSchedule(schedule, scope) || schedule.ownerRef !== actorRef)) ||
        typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256 ||
        (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope))) return err({ kind: "invalidValue" });
    try {
      return await this.db.transaction().execute(async trx => {
        const ids = { tenant_id: scope.tenantId as ClinicSettingsTenantId,
          clinic_id: scope.clinicId as ClinicSettingsClinicId,
          location_id: scope.locationId as ClinicSettingsLocationId };
        const initialPolicy = this.defaultFor(scope);
        await trx.insertInto("clinic_settings").values({ ...ids, version: 0 as ClinicSettingsVersion,
          policy: this.storageMode === "standaloneMinimal"
            ? standalonePolicy(scope, 0, initialPolicy.bookingEnabled, "staffRequest", undefined, undefined, undefined,
                initialPolicy.greeting ?? null, initialPolicy.cancellationEnabled, initialPolicy.reschedulingEnabled, initialPolicy.transferDestinationRef) : initialPolicy })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "location_id", "version"]).doNothing()).execute();
        await trx.selectFrom("clinic_settings").select("version")
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id)
          .where("location_id", "=", ids.location_id).where("version", "=", 0 as ClinicSettingsVersion)
          .forUpdate().executeTakeFirstOrThrow();
        const latest = await trx.selectFrom("clinic_settings").select(["version", "policy"])
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id)
          .where("location_id", "=", ids.location_id).orderBy("version", "desc").limit(1).executeTakeFirstOrThrow();
        const decoded = this.decode(latest.policy, scope, latest.version);
        if (!decoded.ok) return decoded;
        if (decoded.value.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
        const { staffSchedule: oldSchedule, staffedCoverage: oldCoverage, staffedIntervals: oldIntervals, ...base } = decoded.value;
        void oldSchedule; void oldCoverage; void oldIntervals;
        const next: CallPolicy = { ...base, policyVersion: String(latest.version + 1),
          ...(schedule === undefined ? {} : { staffSchedule: structuredClone(schedule) }) };
        await trx.insertInto("clinic_settings").values({ ...ids,
          version: latest.version + 1 as ClinicSettingsVersion,
          policy: this.storageMode === "standaloneMinimal"
            ? standalonePolicy(scope, latest.version + 1, next.bookingEnabled,
              next.afterHoursMode ?? "staffRequest", next.afterHoursInfo, next.urgentResponse, next.staffSchedule,
              next.greeting ?? null, next.cancellationEnabled, next.reschedulingEnabled, next.transferDestinationRef) : next,
          setting_kind: "staffSchedule", changed_by: actorRef, changed_at: sql`clock_timestamp()` }).execute();
        const automation = await trx.selectFrom("clinic_automation").select(["version", "enabled"])
          .where("tenant_id", "=", scope.tenantId as ClinicAutomationTenantId)
          .where("clinic_id", "=", scope.clinicId as ClinicAutomationClinicId)
          .orderBy("version", "desc").limit(1).executeTakeFirst();
        return ok(await this.capture(next, automation, trx));
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async listStaffScheduleChanges(scope: LocationScope, afterVersion?: number): Promise<Result<StaffScheduleSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    try {
      const rows = await this.db.selectFrom("clinic_settings")
        .select(["version", "policy", "changed_by", "changed_at"])
        .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
        .where("location_id", "=", scope.locationId as ClinicSettingsLocationId)
        .where("setting_kind", "=", "staffSchedule")
        .where("version", ">", (afterVersion ?? 0) as ClinicSettingsVersion)
        .orderBy("version", "asc").limit(50).execute();
      const previousRows = rows.length ? await this.db.selectFrom("clinic_settings").select(["version", "policy"])
        .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
        .where("location_id", "=", scope.locationId as ClinicSettingsLocationId)
        .where("version", "in", rows.map(row => row.version - 1 as ClinicSettingsVersion)).execute() : [];
      const previous = new Map(previousRows.map(row => [row.version, row.policy]));
      const entries: StaffScheduleSettingAuditEntry[] = [];
      for (const row of rows) {
        const current = this.decode(row.policy, scope, row.version);
        const before = this.decode(previous.get(row.version - 1 as ClinicSettingsVersion), scope, row.version - 1);
        if (!current.ok) return current;
        if (!before.ok) return before;
        if (typeof row.changed_by !== "string" || !row.changed_by.trim() ||
            !(row.changed_at instanceof Date) || !Number.isFinite(row.changed_at.getTime())) return err({ kind: "storageFailure" });
        entries.push({ version: String(row.version), enabled: current.value.staffSchedule !== undefined,
          previousEnabled: before.value.staffSchedule !== undefined,
          ...(current.value.staffSchedule ? { scheduleVersion: current.value.staffSchedule.version } : {}),
          actorRef: row.changed_by, changedAt: row.changed_at.toISOString() });
      }
      return ok({ entries, ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async changeGreeting(scope: LocationScope, expectedVersion: string,
                       greeting: ApprovedGreeting | undefined, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if ((greeting !== undefined && (!validGreetingShape(greeting, scope) || greeting.ownerRef !== actorRef ||
        greeting.effectiveFrom === undefined || greeting.effectiveUntil === undefined)) ||
        typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256 ||
        (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope))) return err({ kind: "invalidValue" });
    try {
      return await this.db.transaction().execute(async trx => {
        const ids = { tenant_id: scope.tenantId as ClinicSettingsTenantId,
          clinic_id: scope.clinicId as ClinicSettingsClinicId,
          location_id: scope.locationId as ClinicSettingsLocationId };
        const initialPolicy = this.defaultFor(scope);
        await trx.insertInto("clinic_settings").values({ ...ids, version: 0 as ClinicSettingsVersion,
          policy: this.storageMode === "standaloneMinimal"
            ? standalonePolicy(scope, 0, initialPolicy.bookingEnabled, "staffRequest", undefined, undefined, undefined,
                initialPolicy.greeting ?? null, initialPolicy.cancellationEnabled, initialPolicy.reschedulingEnabled, initialPolicy.transferDestinationRef) : initialPolicy })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "location_id", "version"]).doNothing()).execute();
        await trx.selectFrom("clinic_settings").select("version")
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id)
          .where("location_id", "=", ids.location_id).where("version", "=", 0 as ClinicSettingsVersion)
          .forUpdate().executeTakeFirstOrThrow();
        const latest = await trx.selectFrom("clinic_settings").select(["version", "policy"])
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id)
          .where("location_id", "=", ids.location_id).orderBy("version", "desc").limit(1).executeTakeFirstOrThrow();
        const decoded = this.decode(latest.policy, scope, latest.version);
        if (!decoded.ok) return decoded;
        if (decoded.value.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
        const { greeting: previous, ...base } = decoded.value;
        const next: CallPolicy = { ...base, policyVersion: String(latest.version + 1),
          ...(greeting === undefined ? {} : { greeting: structuredClone(greeting) }) };
        await trx.insertInto("clinic_settings").values({ ...ids,
          version: latest.version + 1 as ClinicSettingsVersion,
          policy: this.storageMode === "standaloneMinimal"
            ? standalonePolicy(scope, latest.version + 1, next.bookingEnabled,
              next.afterHoursMode ?? "staffRequest", next.afterHoursInfo, next.urgentResponse, next.staffSchedule,
              next.greeting ?? null, next.cancellationEnabled, next.reschedulingEnabled, next.transferDestinationRef) : next,
          setting_kind: "greeting", changed_by: actorRef, changed_at: sql`clock_timestamp()` }).execute();
        const automation = await trx.selectFrom("clinic_automation").select(["version", "enabled"])
          .where("tenant_id", "=", scope.tenantId as ClinicAutomationTenantId)
          .where("clinic_id", "=", scope.clinicId as ClinicAutomationClinicId)
          .orderBy("version", "desc").limit(1).executeTakeFirst();
        return ok(await this.capture(next, automation, trx));
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async listGreetingChanges(scope: LocationScope, afterVersion?: number): Promise<Result<GreetingSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    try {
      const rows = await this.db.selectFrom("clinic_settings")
        .select(["version", "policy", "changed_by", "changed_at"])
        .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
        .where("location_id", "=", scope.locationId as ClinicSettingsLocationId)
        .where("setting_kind", "=", "greeting")
        .where("version", ">", (afterVersion ?? 0) as ClinicSettingsVersion)
        .orderBy("version", "asc").limit(50).execute();
      const previousRows = rows.length ? await this.db.selectFrom("clinic_settings").select(["version", "policy"])
        .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
        .where("location_id", "=", scope.locationId as ClinicSettingsLocationId)
        .where("version", "in", rows.map(row => row.version - 1 as ClinicSettingsVersion)).execute() : [];
      const previous = new Map(previousRows.map(row => [row.version, row.policy]));
      const entries: GreetingSettingAuditEntry[] = [];
      for (const row of rows) {
        const current = this.decode(row.policy, scope, row.version);
        const before = this.decode(previous.get(row.version - 1 as ClinicSettingsVersion), scope, row.version - 1);
        if (!current.ok) return current;
        if (!before.ok) return before;
        if (typeof row.changed_by !== "string" || !row.changed_by.trim() ||
            !(row.changed_at instanceof Date) || !Number.isFinite(row.changed_at.getTime())) return err({ kind: "storageFailure" });
        entries.push({ version: String(row.version), enabled: current.value.greeting !== undefined,
          previousEnabled: before.value.greeting !== undefined,
          ...(current.value.greeting ? { greetingVersion: current.value.greeting.version } : {}),
          actorRef: row.changed_by, changedAt: row.changed_at.toISOString() });
      }
      return ok({ entries, ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
    } catch { return err({ kind: "storageFailure" }); }
  }
}
