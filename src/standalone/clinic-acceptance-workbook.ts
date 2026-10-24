import { createHash } from "node:crypto";
import type { LocationScope } from "../core/model.ts";
import { approvalInstant, approvalRef } from "./owner-file-clinic-approval.ts";

export const clinicSetupAreas = ["catalogue", "cancellation", "rescheduling", "payments", "staff", "memos"] as const;
export const clinicTrialScenarios = ["catalogue", "booking", "cancellation", "rescheduling", "deposit", "payment-uncertainty",
  "staff-handoff", "backup-handoff", "unresolved-request", "memo-content", "memo-access-retention", "cleanup"] as const;
export type ClinicSetupArea = typeof clinicSetupAreas[number];
type Scenario = typeof clinicTrialScenarios[number];
export type ClinicTrialBinding = Readonly<{
  sourceCommit: string; scope: LocationScope; country: "AU" | "UK" | "NZ" | "CA";
  configuration: Readonly<Record<ClinicSetupArea, string | null>>;
}>;
type Observation = Readonly<{
  scenario: Scenario; status: "notRun" | "passed" | "failed";
  observerRef: string | null; observedAt: string | null; evidenceRef: string | null;
}>;
export type ClinicAcceptanceWorkbook = Readonly<{
  schemaVersion: 1; binding: ClinicTrialBinding; preparedAt: string; observations: readonly Observation[];
}>;
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export function validClinicTrialBinding(value: unknown): value is ClinicTrialBinding {
  if (!exact(value, ["sourceCommit", "scope", "country", "configuration"]) ||
      typeof value.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
      !["AU", "UK", "NZ", "CA"].includes(String(value.country)) ||
      !exact(value.scope, ["tenantId", "clinicId", "locationId"]) || !Object.values(value.scope).every(approvalRef) ||
      !exact(value.configuration, clinicSetupAreas)) return false;
  return Object.values(value.configuration).every(v => v === null || typeof v === "string" && /^[a-f0-9]{64}$/.test(v));
}

/** A worksheet, not an approval record or a runtime permission source. It holds
 * only opaque configuration/observation references, never call or patient facts. */
export function prepareClinicAcceptance(binding: ClinicTrialBinding, now: string): ClinicAcceptanceWorkbook {
  if (!validClinicTrialBinding(binding) || approvalInstant(now) === undefined) throw Error("clinic worksheet unavailable");
  return { schemaVersion: 1, binding: structuredClone(binding), preparedAt: now,
    observations: clinicTrialScenarios.map(scenario => ({ scenario, status: "notRun", observerRef: null, observedAt: null, evidenceRef: null })) };
}

function observation(value: unknown, preparedAt: number, now: number): value is Observation {
  if (!exact(value, ["scenario", "status", "observerRef", "observedAt", "evidenceRef"]) ||
      !clinicTrialScenarios.includes(value.scenario as Scenario) || !["notRun", "passed", "failed"].includes(String(value.status))) return false;
  if (value.status === "notRun") return value.observerRef === null && value.observedAt === null && value.evidenceRef === null;
  const at = approvalInstant(value.observedAt);
  return at !== undefined && at >= preparedAt && at <= now && typeof value.observerRef === "string" &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(value.observerRef) && typeof value.evidenceRef === "string" && /^evidence-[a-f0-9]{16,64}$/.test(value.evidenceRef);
}

/** Recompute the binding from the current checkout and owner configuration.
 * Recorded observations are self-reported: this never asserts staff identity,
 * independently verified clinical success, provider acceptance or go-live. */
export function assessClinicAcceptance(value: unknown, current: ClinicTrialBinding, now: string) {
  const unavailable = { kind: "clinicAcceptance" as const, status: "unavailable" as const, activationAuthorized: false as const };
  if (!validClinicTrialBinding(current) || !exact(value, ["schemaVersion", "binding", "preparedAt", "observations"]) || value.schemaVersion !== 1 ||
      !validClinicTrialBinding(value.binding) || !Array.isArray(value.observations) || value.observations.length !== clinicTrialScenarios.length) return unavailable;
  const at = approvalInstant(now), preparedAt = approvalInstant(value.preparedAt);
  if (at === undefined || preparedAt === undefined || preparedAt > at ||
      !Array.from(value.observations).every(v => observation(v, preparedAt, at)) ||
      new Set(value.observations.map(v => v.scenario)).size !== clinicTrialScenarios.length) return unavailable;
  // Normalize key/row ordering, while binding every configured area's exact bytes.
  const normalize = (b: ClinicTrialBinding) => [b.sourceCommit, b.scope.tenantId, b.scope.clinicId, b.scope.locationId, b.country,
    ...clinicSetupAreas.map(area => b.configuration[area])];
  const stale = digest(normalize(value.binding)) !== digest(normalize(current));
  const missingConfiguration = clinicSetupAreas.filter(area => current.configuration[area] === null);
  const count = (status: Observation["status"]) => value.observations.filter(v => v.status === status).length;
  const failed = count("failed"), notRun = count("notRun");
  return { kind: "clinicAcceptance" as const,
    status: stale ? "stale" as const : missingConfiguration.length ? "configurationIncomplete" as const : failed ? "failed" as const
      : notRun ? "incomplete" as const : "observationsRecorded" as const,
    missingConfiguration, passed: count("passed"), failed, notRun,
    evidenceBasis: "selfReportedStaffObservations" as const, activationAuthorized: false as const };
}
