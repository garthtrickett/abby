import type { PolicyFailure } from "./host.ts";
import type { LocationScope, Result } from "./model.ts";

export type PatientCorrectionClinicScope = Pick<LocationScope, "tenantId" | "clinicId">;
export type ClinicPatientCorrectionState = Readonly<{ version: string; enabled: boolean }>;
export type ClinicPatientCorrectionAuditEntry = Readonly<{
  version: string;
  enabled: boolean;
  previousEnabled: boolean;
  actorRef: string;
  changedAt: string;
}>;
export type ClinicPatientCorrectionAuditPage = Readonly<{
  entries: readonly ClinicPatientCorrectionAuditEntry[];
  nextAfterVersion?: number;
}>;

/** Public configuration only. This store never supplies authority to correct a patient. */
export interface ClinicPatientCorrectionSettingStore {
  read(scope: PatientCorrectionClinicScope): Promise<Result<ClinicPatientCorrectionState, PolicyFailure>>;
  changeEnabled(scope: PatientCorrectionClinicScope, expectedVersion: string, enabled: boolean,
                actorRef: string): Promise<Result<ClinicPatientCorrectionState, PolicyFailure>>;
  listChanges(scope: PatientCorrectionClinicScope, afterVersion?: number): Promise<Result<ClinicPatientCorrectionAuditPage, PolicyFailure>>;
}

export function validPatientCorrectionClinicScope(scope: PatientCorrectionClinicScope): boolean {
  // Match the core/gateway opaque scope contract. Standalone profile restrictions belong to its adapter.
  return !!scope && [scope.tenantId, scope.clinicId].every(value =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(value));
}

export function validPatientCorrectionSettingChange(scope: PatientCorrectionClinicScope, expectedVersion: string,
                                        enabled: boolean, actorRef: string): boolean {
  return validPatientCorrectionClinicScope(scope) && typeof expectedVersion === "string" && /^(0|[1-9][0-9]*)$/.test(expectedVersion) &&
    Number.isSafeInteger(Number(expectedVersion)) && Number(expectedVersion) < 2_147_483_647 &&
    typeof enabled === "boolean" && typeof actorRef === "string" &&
    actorRef.trim().length > 0 && actorRef.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(actorRef);
}

export function validPatientCorrectionAuditCursor(afterVersion: number | undefined): boolean {
  return afterVersion === undefined || Number.isSafeInteger(afterVersion) && afterVersion >= 0;
}
