import type { PolicyFailure } from "./host.ts";
import type { LocationScope, Result } from "./model.ts";

export type IntakeClinicScope = Pick<LocationScope, "tenantId" | "clinicId">;
export type ClinicIntakeState = Readonly<{ version: string; enabled: boolean }>;
export type ClinicIntakeAuditEntry = Readonly<{
  version: string;
  enabled: boolean;
  previousEnabled: boolean;
  actorRef: string;
  changedAt: string;
}>;
export type ClinicIntakeAuditPage = Readonly<{
  entries: readonly ClinicIntakeAuditEntry[];
  nextAfterVersion?: number;
}>;

/** Public configuration only. This store never supplies authority to create a patient. */
export interface ClinicIntakeSettingStore {
  read(scope: IntakeClinicScope): Promise<Result<ClinicIntakeState, PolicyFailure>>;
  changeEnabled(scope: IntakeClinicScope, expectedVersion: string, enabled: boolean,
                actorRef: string): Promise<Result<ClinicIntakeState, PolicyFailure>>;
  listChanges(scope: IntakeClinicScope, afterVersion?: number): Promise<Result<ClinicIntakeAuditPage, PolicyFailure>>;
}

export function validIntakeClinicScope(scope: IntakeClinicScope): boolean {
  // Match the core/gateway opaque scope contract. Standalone profile restrictions belong to its adapter.
  return !!scope && [scope.tenantId, scope.clinicId].every(value =>
    typeof value === "string" && value.length > 0);
}

export function validIntakeSettingChange(scope: IntakeClinicScope, expectedVersion: string,
                                        enabled: boolean, actorRef: string): boolean {
  return validIntakeClinicScope(scope) && typeof expectedVersion === "string" &&
    typeof enabled === "boolean" && typeof actorRef === "string" &&
    actorRef.trim().length > 0 && actorRef.length <= 256;
}

export function validIntakeAuditCursor(afterVersion: number | undefined): boolean {
  return afterVersion === undefined || Number.isSafeInteger(afterVersion) && afterVersion >= 0;
}
