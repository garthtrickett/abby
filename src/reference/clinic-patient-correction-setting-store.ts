import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { PolicyFailure } from "../core/host.ts";
import { validPatientCorrectionAuditCursor, validPatientCorrectionClinicScope, validPatientCorrectionSettingChange } from "../core/clinic-patient-correction-setting.ts";
import type { ClinicPatientCorrectionAuditEntry, ClinicPatientCorrectionAuditPage, ClinicPatientCorrectionSettingStore,
  ClinicPatientCorrectionState, PatientCorrectionClinicScope } from "../core/clinic-patient-correction-setting.ts";

function clinicKey(scope: PatientCorrectionClinicScope): string {
  return JSON.stringify([scope.tenantId, scope.clinicId]);
}

export class MemoryClinicPatientCorrectionSettingStore implements ClinicPatientCorrectionSettingStore {
  private readonly states = new Map<string, ClinicPatientCorrectionState>();
  private readonly histories = new Map<string, ClinicPatientCorrectionAuditEntry[]>();
  private readonly clock: () => string;

  constructor(clock: () => string = () => new Date().toISOString()) { this.clock = clock; }

  /** Carry source history into a fresh target, then record a distinct target disable when needed. */
  importDisabled(scope: PatientCorrectionClinicScope, source: ClinicPatientCorrectionState, history: readonly ClinicPatientCorrectionAuditEntry[],
                 actorRef: string, importedAt: string): void {
    if (!validPatientCorrectionSettingChange(scope, source.version, source.enabled, actorRef) ||
        !/^(0|[1-9][0-9]*)$/.test(source.version) || !Number.isSafeInteger(Number(source.version)) ||
        Number(source.version) !== history.length || !Number.isFinite(Date.parse(importedAt))) {
      throw new Error("invalid clinic patient correction import");
    }
    let previous = false;
    for (const [index, entry] of history.entries()) {
      if (entry.version !== String(index + 1) || entry.previousEnabled !== previous ||
          !validPatientCorrectionSettingChange(scope, entry.version, entry.enabled, entry.actorRef) ||
          !Number.isFinite(Date.parse(entry.changedAt))) throw new Error("invalid clinic patient correction import history");
      previous = entry.enabled;
    }
    const key = clinicKey(scope);
    if (source.enabled !== previous || this.states.has(key)) throw new Error("invalid or occupied clinic patient correction import");
    const entries = structuredClone([...history]);
    let version = Number(source.version);
    if (source.enabled) {
      version += 1;
      entries.push({ version: String(version), enabled: false, previousEnabled: true, actorRef, changedAt: importedAt });
    }
    this.states.set(key, { version: String(version), enabled: false });
    this.histories.set(key, entries);
  }

  /** Used by the reference policy composer; never returns an alias to mutable state. */
  current(scope: PatientCorrectionClinicScope): ClinicPatientCorrectionState {
    return structuredClone(this.states.get(clinicKey(scope)) ?? { version: "0", enabled: false });
  }

  async read(scope: PatientCorrectionClinicScope): Promise<Result<ClinicPatientCorrectionState, PolicyFailure>> {
    return validPatientCorrectionClinicScope(scope) ? ok(this.current(scope)) : err({ kind: "invalidValue" });
  }

  async changeEnabled(scope: PatientCorrectionClinicScope, expectedVersion: string, enabled: boolean,
                      actorRef: string): Promise<Result<ClinicPatientCorrectionState, PolicyFailure>> {
    if (!validPatientCorrectionSettingChange(scope, expectedVersion, enabled, actorRef)) return err({ kind: "invalidValue" });
    const key = clinicKey(scope);
    const previous = this.current(scope);
    if (previous.version !== expectedVersion) return err({ kind: "versionConflict" });
    let changedAt: string;
    try { changedAt = this.clock(); }
    catch { return err({ kind: "storageFailure" }); }
    if (typeof changedAt !== "string" || !Number.isFinite(Date.parse(changedAt))) return err({ kind: "storageFailure" });
    const next = { version: String(Number(previous.version) + 1), enabled };
    this.states.set(key, next);
    const history = this.histories.get(key) ?? [];
    history.push({ ...next, previousEnabled: previous.enabled, actorRef, changedAt });
    this.histories.set(key, history);
    return ok(structuredClone(next));
  }

  async listChanges(scope: PatientCorrectionClinicScope, afterVersion?: number): Promise<Result<ClinicPatientCorrectionAuditPage, PolicyFailure>> {
    if (!validPatientCorrectionClinicScope(scope) || !validPatientCorrectionAuditCursor(afterVersion)) return err({ kind: "invalidValue" });
    const entries = (this.histories.get(clinicKey(scope)) ?? [])
      .filter(row => Number(row.version) > (afterVersion ?? 0)).slice(0, 50);
    return ok({ entries: structuredClone(entries),
      ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
  }
}
