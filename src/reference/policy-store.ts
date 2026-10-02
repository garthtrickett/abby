import { MemoryClinicIntakeSettingStore } from "./clinic-intake-setting-store.ts";
import type { ClinicIntakeAuditEntry, ClinicIntakeAuditPage } from "../core/clinic-intake-setting.ts";
import { captureStaffedDestination, listStaffedDestinations, resolveStaffedDestination, unprovenStaffedDestinationRegistry, validStaffedDestinationChange, validStaffedDestinationScope } from "../core/staffed-destination.ts";
import type { StaffedDestinationAuditEntry, StaffedDestinationAuditPage, StaffedDestinationCatalogue, StaffedDestinationRegistry } from "../core/staffed-destination.ts";
import type { AfterHoursSettingAuditEntry, AfterHoursSettingAuditPage, AutomationSettingAuditEntry, AutomationSettingAuditPage, BookingSettingAuditEntry, BookingSettingAuditPage, GreetingSettingAuditEntry, GreetingSettingAuditPage, StaffScheduleSettingAuditEntry, StaffScheduleSettingAuditPage, UrgentSettingAuditEntry, UrgentSettingAuditPage, PolicyStore, PolicyFailure } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { PatientSettingModes, AfterHoursMode, ApprovedAfterHoursInfo, ApprovedGreeting, ApprovedStaffSchedule, ApprovedUrgentResponse, CallPolicy, CapabilityMode, LocationScope, Result } from "../core/model.ts";
import { validAfterHoursSetting } from "../core/after-hours-policy.ts";
import { validGreetingShape } from "../core/greeting.ts";
import { validApprovedStaffSchedule } from "../core/staff-schedule.ts";
import { validUrgentResponseShape } from "../core/urgent-response.ts";
import { READINESS_REQUIREMENTS, unprovenReadiness } from "../core/readiness.ts";
import type { AutomationReadiness } from "../core/readiness.ts";
import type { CancellationSettingAuditEntry, CancellationSettingAuditPage, ReschedulingSettingAuditEntry, ReschedulingSettingAuditPage } from "../core/host.ts";

export function referenceDefaultPolicy(scope: LocationScope): CallPolicy {
  return {
    scope: structuredClone(scope),
    policyVersion: "0",
    automationVersion: "0",
    automationEnabled: false,
    bookingEnabled: false,
    cancellationEnabled: false,
    reschedulingEnabled: false,
    afterHoursMode: "staffRequest",
    capabilities: { book: "unavailable", cancel: "requestOnly", reschedule: "requestOnly", intake: "requestOnly", transfer: "requestOnly" },
    staffDestination: { kind: "owner", ownerRef: `reference-staff:${scope.tenantId}:${scope.clinicId}` },
    operatorQueue: { kind: "queue", queueRef: `reference-review:${scope.tenantId}:${scope.clinicId}` },
    greeting: { scope: structuredClone(scope), version: "reference-greeting-v1", ownerRef: "reference-fixture",
      approvedText: "Hello. How can I help you?", approved: true },
  };
}

function scopeKey(scope: LocationScope): string {
  return JSON.stringify([scope.tenantId, scope.clinicId, scope.locationId]);
}

function clinicKey(scope: LocationScope): string {
  return JSON.stringify([scope.tenantId, scope.clinicId]);
}

export type ImportedReferenceLocationPolicy = Readonly<{
  scope: LocationScope;
  policy: CallPolicy;
  bookingHistory: readonly BookingSettingAuditEntry[];
  afterHoursHistory?: readonly AfterHoursSettingAuditEntry[];
  urgentHistory?: readonly UrgentSettingAuditEntry[];
  staffScheduleHistory?: readonly StaffScheduleSettingAuditEntry[];
  greetingHistory?: readonly GreetingSettingAuditEntry[];
  cancellationHistory?: readonly CancellationSettingAuditEntry[];
  reschedulingHistory?: readonly ReschedulingSettingAuditEntry[];
  staffedDestinationHistory?: readonly StaffedDestinationAuditEntry[];
}>;

export type ImportedReferenceClinicAutomation = Readonly<{
  scope: LocationScope;
  history: readonly AutomationSettingAuditEntry[];
  sourceVersion: number;
  sourceEnabled: boolean;
  intake?: Readonly<{ history: readonly ClinicIntakeAuditEntry[]; sourceVersion: number; sourceEnabled: boolean }>;
}>;

export class MemoryPolicyStore implements PolicyStore {
  private readonly policies = new Map<string, CallPolicy>();
  private readonly clinicAutomation = new Map<string, Readonly<{ version: number; enabled: boolean }>>();
  private readonly bookingChanges = new Map<string, BookingSettingAuditEntry[]>();
  private readonly cancellationChanges = new Map<string, CancellationSettingAuditEntry[]>();
  private readonly reschedulingChanges = new Map<string, ReschedulingSettingAuditEntry[]>();
  private readonly afterHoursChanges = new Map<string, AfterHoursSettingAuditEntry[]>();
  private readonly urgentChanges = new Map<string, UrgentSettingAuditEntry[]>();
  private readonly staffScheduleChanges = new Map<string, StaffScheduleSettingAuditEntry[]>();
  private readonly greetingChanges = new Map<string, GreetingSettingAuditEntry[]>();
  private readonly automationChanges = new Map<string, AutomationSettingAuditEntry[]>();
  private readonly hostBookingMode: Extract<CapabilityMode, "execute" | "requestOnly">;
  private readonly clock: () => string;
  private readonly readiness: AutomationReadiness;
  private readonly hostCancellationMode: CapabilityMode;
  private readonly hostReschedulingMode: CapabilityMode;
  private readonly hostIntakeMode: CapabilityMode;
  private readonly intake: MemoryClinicIntakeSettingStore;
  private readonly staffedDestinationRegistry: StaffedDestinationRegistry;
  private readonly staffedDestinationChanges = new Map<string, StaffedDestinationAuditEntry[]>();

  constructor(hostBookingMode: Extract<CapabilityMode, "execute" | "requestOnly"> = "execute", clock: () => string = () => new Date().toISOString(), readiness: AutomationReadiness = unprovenReadiness,
              hostPatientModes: CapabilityMode | PatientSettingModes = "requestOnly",
              staffedDestinationRegistry: StaffedDestinationRegistry = unprovenStaffedDestinationRegistry) {
    this.hostBookingMode = hostBookingMode;
    this.clock = clock;
    this.intake = new MemoryClinicIntakeSettingStore(clock);
    this.readiness = readiness;
    this.hostCancellationMode = typeof hostPatientModes === "string" ? hostPatientModes : hostPatientModes.cancellation ?? "unavailable";
    this.hostReschedulingMode = typeof hostPatientModes === "string" ? "unavailable" : hostPatientModes.rescheduling ?? "unavailable";
    this.hostIntakeMode = typeof hostPatientModes === "string" ? "unavailable" : hostPatientModes.intake ?? "unavailable";
    this.staffedDestinationRegistry = staffedDestinationRegistry;
  }

  /** Builds a disabled, request-only target policy from a validated historical import. */
  static fromImported(scope: LocationScope, sourceHead: CallPolicy, bookingHistory: readonly BookingSettingAuditEntry[],
                      afterHoursHistory: readonly AfterHoursSettingAuditEntry[],
                      automationHistory: readonly AutomationSettingAuditEntry[], sourceAutomationVersion: number,
                      sourceAutomationEnabled: boolean, importActorRef: string, importedAt: string,
                      urgentHistory: readonly UrgentSettingAuditEntry[] = [],
                      staffScheduleHistory: readonly StaffScheduleSettingAuditEntry[] = [],
                      greetingHistory: readonly GreetingSettingAuditEntry[] = [],
                      cancellationHistory: readonly CancellationSettingAuditEntry[] = [],
                      reschedulingHistory: readonly ReschedulingSettingAuditEntry[] = [],
                      intake?: ImportedReferenceClinicAutomation["intake"],
                      staffedDestinationHistory: readonly StaffedDestinationAuditEntry[] = []): MemoryPolicyStore {
    return MemoryPolicyStore.fromImportedMany(
      [{ scope, policy: sourceHead, bookingHistory, afterHoursHistory, urgentHistory, staffScheduleHistory, greetingHistory, cancellationHistory, reschedulingHistory, staffedDestinationHistory }],
      [{ scope, history: automationHistory, sourceVersion: sourceAutomationVersion, sourceEnabled: sourceAutomationEnabled, ...(intake ? { intake } : {}) }],
      importActorRef, importedAt);
  }

  /** One reference policy store keeps clinic automation shared across imported locations. */
  static fromImportedMany(locations: readonly ImportedReferenceLocationPolicy[], clinics: readonly ImportedReferenceClinicAutomation[],
                          importActorRef: string, importedAt: string): MemoryPolicyStore {
    const store = new MemoryPolicyStore("requestOnly");
    for (const location of locations) {
      const key = scopeKey(location.scope);
      if (store.policies.has(key) || scopeKey(location.policy.scope) !== key) throw new Error("duplicate or mismatched imported location");
      const policy = structuredClone(location.policy);
      const changes = structuredClone([...location.bookingHistory]);
      if (policy.bookingEnabled) {
        const version = String(Number(policy.policyVersion) + 1);
        changes.push({ version, enabled: false, previousEnabled: true, actorRef: importActorRef, changedAt: importedAt, provenance: "recorded" });
        store.policies.set(key, { ...policy, policyVersion: version, bookingEnabled: false,
          capabilities: { ...policy.capabilities, book: "unavailable" } });
      } else {
        store.policies.set(key, { ...policy, capabilities: { ...policy.capabilities, book: "unavailable" } });
      }
      store.bookingChanges.set(key, changes);
      const cancellation = structuredClone([...(location.cancellationHistory ?? [])]);
      const adjusted = store.policies.get(key)!;
      if (adjusted.cancellationEnabled === true) {
        const version = String(Number(adjusted.policyVersion) + 1);
        cancellation.push({ version, enabled: false, previousEnabled: true,
          actorRef: importActorRef, changedAt: importedAt });
        store.policies.set(key, { ...adjusted, policyVersion: version, cancellationEnabled: false,
          capabilities: { ...adjusted.capabilities, cancel: "unavailable" } });
      }
      store.cancellationChanges.set(key, cancellation);
      const rescheduling = structuredClone([...(location.reschedulingHistory ?? [])]);
      const reschedulingAdjusted = store.policies.get(key)!;
      if (reschedulingAdjusted.reschedulingEnabled === true) {
        const version = String(Number(reschedulingAdjusted.policyVersion) + 1);
        rescheduling.push({ version, enabled: false, previousEnabled: true,
          actorRef: importActorRef, changedAt: importedAt });
        store.policies.set(key, { ...reschedulingAdjusted, policyVersion: version, reschedulingEnabled: false,
          capabilities: { ...reschedulingAdjusted.capabilities, reschedule: "unavailable" } });
      }
      store.reschedulingChanges.set(key, rescheduling);
      store.afterHoursChanges.set(key, structuredClone([...(location.afterHoursHistory ?? [])]));
      store.urgentChanges.set(key, structuredClone([...(location.urgentHistory ?? [])]));
      store.staffScheduleChanges.set(key, structuredClone([...(location.staffScheduleHistory ?? [])]));
      store.greetingChanges.set(key, structuredClone([...(location.greetingHistory ?? [])]));
      store.staffedDestinationChanges.set(key, structuredClone([...(location.staffedDestinationHistory ?? [])]));
    }
    for (const clinic of clinics) {
      const key = clinicKey(clinic.scope);
      if (store.clinicAutomation.has(key)) throw new Error("duplicate imported clinic");
      const automation = structuredClone([...clinic.history]);
      let version = clinic.sourceVersion;
      if (clinic.sourceEnabled) {
        version += 1;
        automation.push({ version: String(version), enabled: false, previousEnabled: true,
          actorRef: importActorRef, changedAt: importedAt });
      }
      store.clinicAutomation.set(key, { version, enabled: false });
      store.automationChanges.set(key, automation);
      store.intake.importDisabled(clinic.scope, { version: String(clinic.intake?.sourceVersion ?? 0),
        enabled: clinic.intake?.sourceEnabled ?? false }, clinic.intake?.history ?? [], importActorRef, importedAt);
    }
    return store;
  }

  private effective(policy: CallPolicy): CallPolicy {
    const automation = this.clinicAutomation.get(clinicKey(policy.scope));
    const intake = this.intake.current(policy.scope);
    return { ...policy, cancellationEnabled: policy.cancellationEnabled ?? false, reschedulingEnabled: policy.reschedulingEnabled ?? false,
      automationVersion: String(automation?.version ?? 0), automationEnabled: automation?.enabled ?? false,
      firstTimeIntakeVersion: intake.version, firstTimeIntakeEnabled: intake.enabled,
      capabilities: { ...policy.capabilities, book: policy.bookingEnabled ? this.hostBookingMode : "unavailable",
        cancel: policy.cancellationEnabled === true ? this.hostCancellationMode : "unavailable",
        reschedule: policy.reschedulingEnabled === true ? this.hostReschedulingMode : "unavailable",
        intake: intake.enabled ? this.hostIntakeMode : "unavailable" } };
  }

  async read(scope: LocationScope): Promise<Result<CallPolicy, PolicyFailure>> {
    return ok(await captureStaffedDestination(this.effective(this.policies.get(scopeKey(scope)) ?? referenceDefaultPolicy(scope)),
      (bound, ref) => this.staffedDestinationRegistry.resolve(bound, ref)));
  }

  async listStaffedDestinations(scope: LocationScope): Promise<Result<StaffedDestinationCatalogue, PolicyFailure>> {
    return listStaffedDestinations(this.staffedDestinationRegistry, scope);
  }

  async changeStaffedDestination(scope: LocationScope, expectedVersion: string, destinationRef: string | null,
                                actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (!validStaffedDestinationChange(scope, expectedVersion, destinationRef, actorRef)) return err({ kind: "invalidValue" });
    const key = scopeKey(scope);
    const current = this.policies.get(key) ?? referenceDefaultPolicy(scope);
    if (current.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
    if (destinationRef !== null) {
      const evidence = await resolveStaffedDestination((bound, ref) => this.staffedDestinationRegistry.resolve(bound, ref), scope, destinationRef);
      if (!evidence.ok) return evidence;
    }
    // Host validation may await. All location edits share this version, including booking and hours.
    if ((this.policies.get(key)?.policyVersion ?? "0") !== expectedVersion) return err({ kind: "versionConflict" });
    let changedAt: string;
    try { changedAt = this.clock(); }
    catch { return err({ kind: "storageFailure" }); }
    if (!Number.isFinite(Date.parse(changedAt))) return err({ kind: "storageFailure" });
    const { transferDestinationRef: previous, transferDestinationVersion: hostVersion, ...base } = current;
    void hostVersion;
    const next: CallPolicy = { ...base, policyVersion: String(Number(expectedVersion) + 1),
      ...(destinationRef === null ? {} : { transferDestinationRef: destinationRef }) };
    this.policies.set(key, structuredClone(next));
    const history = this.staffedDestinationChanges.get(key) ?? [];
    history.push({ version: next.policyVersion, destinationRef, previousDestinationRef: previous ?? null, actorRef, changedAt });
    this.staffedDestinationChanges.set(key, history);
    return this.read(scope);
  }

  async listStaffedDestinationChanges(scope: LocationScope, afterVersion?: number): Promise<Result<StaffedDestinationAuditPage, PolicyFailure>> {
    if (!validStaffedDestinationScope(scope) ||
        (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0))) return err({ kind: "invalidValue" });
    const entries = (this.staffedDestinationChanges.get(scopeKey(scope)) ?? [])
      .filter(item => Number(item.version) > (afterVersion ?? 0)).slice(0, 50);
    return ok({ entries: structuredClone(entries),
      ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
  }

  async changeAutomationEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (typeof enabled !== "boolean" || typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256) return err({ kind: "invalidValue" });
    const current = this.clinicAutomation.get(clinicKey(scope)) ?? { version: 0, enabled: false };
    if (String(current.version) !== expectedVersion) return err({ kind: "versionConflict" });
    if (enabled) {
      try {
        const ready = await this.readiness(scope);
        if (!ready.ok) return ready;
        if (ready.value !== true) return err({ kind: "readinessFailed", missing: READINESS_REQUIREMENTS });
      } catch { return err({ kind: "readinessFailed", missing: READINESS_REQUIREMENTS }); }
    }
    let changedAt: string;
    try { changedAt = this.clock(); }
    catch { return err({ kind: "storageFailure" }); }
    if (!Number.isFinite(Date.parse(changedAt))) return err({ kind: "storageFailure" });
    // The readiness check may await a host. Recheck the clinic version before committing.
    if ((this.clinicAutomation.get(clinicKey(scope))?.version ?? 0) !== current.version) return err({ kind: "versionConflict" });
    const next = { version: current.version + 1, enabled };
    this.clinicAutomation.set(clinicKey(scope), next);
    const history = this.automationChanges.get(clinicKey(scope)) ?? [];
    history.push({ version: String(next.version), enabled, previousEnabled: current.enabled, actorRef, changedAt });
    this.automationChanges.set(clinicKey(scope), history);
    return this.read(scope);
  }

  async listAutomationChanges(scope: LocationScope, afterVersion?: number): Promise<Result<AutomationSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    const entries = (this.automationChanges.get(clinicKey(scope)) ?? []).filter(item => Number(item.version) > (afterVersion ?? 0)).slice(0, 50);
    return ok({ entries: structuredClone(entries), ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
  }

  async changeFirstTimeIntakeEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean,
                                   actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    const changed = await this.intake.changeEnabled(scope, expectedVersion, enabled, actorRef);
    return changed.ok ? this.read(scope) : changed;
  }

  async listFirstTimeIntakeChanges(scope: LocationScope, afterVersion?: number): Promise<Result<ClinicIntakeAuditPage, PolicyFailure>> {
    return this.intake.listChanges(scope, afterVersion);
  }

  async changeBookingEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (typeof enabled !== "boolean" || typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256) return err({ kind: "invalidValue" });
    const current = this.policies.get(scopeKey(scope)) ?? referenceDefaultPolicy(scope);
    if (current.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
    let changedAt: string;
    try { changedAt = this.clock(); }
    catch { return err({ kind: "storageFailure" }); }
    if (!Number.isFinite(Date.parse(changedAt))) return err({ kind: "storageFailure" });
    const next: CallPolicy = {
      ...current,
      policyVersion: String(Number(current.policyVersion) + 1),
      bookingEnabled: enabled,
      capabilities: { ...current.capabilities, book: enabled ? this.hostBookingMode : "unavailable" },
    };
    this.policies.set(scopeKey(scope), structuredClone(next));
    const history = this.bookingChanges.get(scopeKey(scope)) ?? [];
    history.push({ version: next.policyVersion, enabled, previousEnabled: current.bookingEnabled,
      actorRef, changedAt, provenance: "recorded" });
    this.bookingChanges.set(scopeKey(scope), history);
    return this.read(scope);
  }

  async listBookingChanges(scope: LocationScope, afterVersion?: number): Promise<Result<BookingSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    const entries = (this.bookingChanges.get(scopeKey(scope)) ?? []).filter(item => Number(item.version) > (afterVersion ?? 0)).slice(0, 50);
    return ok({ entries: structuredClone(entries), ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
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
    if (typeof enabled !== "boolean" || typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256) {
      return err({ kind: "invalidValue" });
    }
    const field = setting === "cancellation" ? "cancellationEnabled" : "reschedulingEnabled";
    const capability = setting === "cancellation" ? "cancel" : "reschedule";
    const hostMode = setting === "cancellation" ? this.hostCancellationMode : this.hostReschedulingMode;
    const changes = setting === "cancellation" ? this.cancellationChanges : this.reschedulingChanges;
    const key = scopeKey(scope);
    const current = this.policies.get(key) ?? referenceDefaultPolicy(scope);
    if (current.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
    let changedAt: string;
    try { changedAt = this.clock(); }
    catch { return err({ kind: "storageFailure" }); }
    if (!Number.isFinite(Date.parse(changedAt))) return err({ kind: "storageFailure" });
    const next: CallPolicy = { ...current, policyVersion: String(Number(current.policyVersion) + 1), [field]: enabled,
      capabilities: { ...current.capabilities, [capability]: enabled ? hostMode : "unavailable" } };
    this.policies.set(key, structuredClone(next));
    const history = changes.get(key) ?? [];
    history.push({ version: next.policyVersion, enabled, previousEnabled: current[field] ?? false,
      actorRef, changedAt });
    changes.set(key, history);
    return this.read(scope);
  }

  private async listAppointmentChanges(setting: "cancellation" | "rescheduling", scope: LocationScope, afterVersion?: number): Promise<Result<CancellationSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    const changes = setting === "cancellation" ? this.cancellationChanges : this.reschedulingChanges;
    const entries = (changes.get(scopeKey(scope)) ?? [])
      .filter(item => Number(item.version) > (afterVersion ?? 0)).slice(0, 50);
    return ok({ entries: structuredClone(entries), ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
  }

  async changeAfterHours(scope: LocationScope, expectedVersion: string, mode: AfterHoursMode,
                         info: ApprovedAfterHoursInfo | undefined, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (!validAfterHoursSetting(mode, info, scope) || typeof actorRef !== "string" || !actorRef.trim() ||
        actorRef.length > 256) return err({ kind: "invalidValue" });
    const current = this.policies.get(scopeKey(scope)) ?? referenceDefaultPolicy(scope);
    if (current.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
    let changedAt: string;
    try { changedAt = this.clock(); }
    catch { return err({ kind: "storageFailure" }); }
    if (!Number.isFinite(Date.parse(changedAt))) return err({ kind: "storageFailure" });
    const { afterHoursInfo: previousInfo, ...base } = current;
    void previousInfo;
    const next: CallPolicy = { ...base, policyVersion: String(Number(current.policyVersion) + 1),
      afterHoursMode: mode,
      ...(mode === "approvedInfoAndRequest" ? { afterHoursInfo: structuredClone(info!) } : {}) };
    this.policies.set(scopeKey(scope), structuredClone(next));
    const history = this.afterHoursChanges.get(scopeKey(scope)) ?? [];
    history.push({ version: next.policyVersion, mode, previousMode: current.afterHoursMode ?? "staffRequest",
      ...(info ? { infoVersion: info.version } : {}), actorRef, changedAt });
    this.afterHoursChanges.set(scopeKey(scope), history);
    return this.read(scope);
  }

  async listAfterHoursChanges(scope: LocationScope, afterVersion?: number): Promise<Result<AfterHoursSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    const entries = (this.afterHoursChanges.get(scopeKey(scope)) ?? [])
      .filter(item => Number(item.version) > (afterVersion ?? 0)).slice(0, 50);
    return ok({ entries: structuredClone(entries),
      ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
  }

  async changeUrgentResponse(scope: LocationScope, expectedVersion: string,
                             response: ApprovedUrgentResponse | undefined, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if ((response !== undefined && (!validUrgentResponseShape(response, scope) || response.ownerRef !== actorRef)) ||
        typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256) return err({ kind: "invalidValue" });
    const current = this.policies.get(scopeKey(scope)) ?? referenceDefaultPolicy(scope);
    if (current.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
    let changedAt: string;
    try { changedAt = this.clock(); }
    catch { return err({ kind: "storageFailure" }); }
    if (!Number.isFinite(Date.parse(changedAt))) return err({ kind: "storageFailure" });
    const { urgentResponse: previousResponse, ...base } = current;
    const next: CallPolicy = { ...base, policyVersion: String(Number(current.policyVersion) + 1),
      ...(response === undefined ? {} : { urgentResponse: structuredClone(response) }) };
    this.policies.set(scopeKey(scope), structuredClone(next));
    const history = this.urgentChanges.get(scopeKey(scope)) ?? [];
    history.push({ version: next.policyVersion, enabled: response !== undefined,
      previousEnabled: previousResponse !== undefined,
      ...(response === undefined ? {} : { scriptVersion: response.version }), actorRef, changedAt });
    this.urgentChanges.set(scopeKey(scope), history);
    return this.read(scope);
  }

  async listUrgentResponseChanges(scope: LocationScope, afterVersion?: number): Promise<Result<UrgentSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    const entries = (this.urgentChanges.get(scopeKey(scope)) ?? [])
      .filter(item => Number(item.version) > (afterVersion ?? 0)).slice(0, 50);
    return ok({ entries: structuredClone(entries),
      ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
  }

  async changeStaffSchedule(scope: LocationScope, expectedVersion: string, schedule: ApprovedStaffSchedule | undefined,
                            actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if ((schedule !== undefined && (!validApprovedStaffSchedule(schedule, scope) || schedule.ownerRef !== actorRef)) ||
        typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256) return err({ kind: "invalidValue" });
    const current = this.policies.get(scopeKey(scope)) ?? referenceDefaultPolicy(scope);
    if (current.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
    let changedAt: string;
    try { changedAt = this.clock(); }
    catch { return err({ kind: "storageFailure" }); }
    if (!Number.isFinite(Date.parse(changedAt))) return err({ kind: "storageFailure" });
    const { staffSchedule: previous, staffedCoverage: oldCoverage, staffedIntervals: oldIntervals, ...base } = current;
    void oldCoverage; void oldIntervals;
    const next: CallPolicy = { ...base, policyVersion: String(Number(current.policyVersion) + 1),
      ...(schedule === undefined ? {} : { staffSchedule: structuredClone(schedule) }) };
    this.policies.set(scopeKey(scope), structuredClone(next));
    const history = this.staffScheduleChanges.get(scopeKey(scope)) ?? [];
    history.push({ version: next.policyVersion, enabled: schedule !== undefined, previousEnabled: previous !== undefined,
      ...(schedule === undefined ? {} : { scheduleVersion: schedule.version }), actorRef, changedAt });
    this.staffScheduleChanges.set(scopeKey(scope), history);
    return this.read(scope);
  }

  async listStaffScheduleChanges(scope: LocationScope, afterVersion?: number): Promise<Result<StaffScheduleSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    const entries = (this.staffScheduleChanges.get(scopeKey(scope)) ?? [])
      .filter(item => Number(item.version) > (afterVersion ?? 0)).slice(0, 50);
    return ok({ entries: structuredClone(entries),
      ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
  }

  async changeGreeting(scope: LocationScope, expectedVersion: string, greeting: ApprovedGreeting | undefined,
                       actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if ((greeting !== undefined && (!validGreetingShape(greeting, scope) || greeting.ownerRef !== actorRef ||
        greeting.effectiveFrom === undefined || greeting.effectiveUntil === undefined)) ||
        typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256) return err({ kind: "invalidValue" });
    const current = this.policies.get(scopeKey(scope)) ?? referenceDefaultPolicy(scope);
    if (current.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
    let changedAt: string;
    try { changedAt = this.clock(); }
    catch { return err({ kind: "storageFailure" }); }
    if (!Number.isFinite(Date.parse(changedAt))) return err({ kind: "storageFailure" });
    const { greeting: previous, ...base } = current;
    const next: CallPolicy = { ...base, policyVersion: String(Number(current.policyVersion) + 1),
      ...(greeting === undefined ? {} : { greeting: structuredClone(greeting) }) };
    this.policies.set(scopeKey(scope), structuredClone(next));
    const history = this.greetingChanges.get(scopeKey(scope)) ?? [];
    history.push({ version: next.policyVersion, enabled: greeting !== undefined, previousEnabled: previous !== undefined,
      ...(greeting === undefined ? {} : { greetingVersion: greeting.version }), actorRef, changedAt });
    this.greetingChanges.set(scopeKey(scope), history);
    return this.read(scope);
  }

  async listGreetingChanges(scope: LocationScope, afterVersion?: number): Promise<Result<GreetingSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    const entries = (this.greetingChanges.get(scopeKey(scope)) ?? [])
      .filter(item => Number(item.version) > (afterVersion ?? 0)).slice(0, 50);
    return ok({ entries: structuredClone(entries),
      ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
  }
}
