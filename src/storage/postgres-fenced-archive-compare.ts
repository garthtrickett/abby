import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { ArchiveEnvelope, ArchiveSection } from "../portability/archive-envelope.ts";
import { decodeTenantConfigArchive } from "../portability/config-archive.ts";
import type { ConfigArchiveDecodeFailure, TenantConfigArchiveData } from "../portability/config-archive.ts";
import type Database from "./generated/Database.ts";
import { buildPostgresFencedTenantConfigArchive, validTenantConfigArchiveRequest } from "./postgres-config-archive.ts";
import type { ConfigArchiveFailure, TenantConfigArchiveAuthority, TenantConfigArchiveRequest } from "./postgres-config-archive.ts";

export type FencedArchiveComparisonFailure = ConfigArchiveFailure | ConfigArchiveDecodeFailure | Readonly<{
  kind: "baselineMismatch" | "archiveIdReused";
}>;

export type FencedArchiveComparison = Readonly<{
  kind: "unchanged" | "changed";
  baselineArchiveId: string;
  baselineManifestDigest: string;
  comparisonArchiveId: string;
  comparisonManifestDigest: string;
  sourceFenceVersion: number;
  changed: readonly (ArchiveSection | "sourceSchema" | "omittedCalls")[];
}>;

function sameMappings(baseline: TenantConfigArchiveData, request: TenantConfigArchiveRequest): boolean {
  if (baseline.locations.length !== request.locations.length) return false;
  return baseline.locations.every(location => request.locations.some(mapping =>
    mapping.sourceScope.tenantId === location.sourceScope.tenantId &&
    mapping.sourceScope.clinicId === location.sourceScope.clinicId &&
    mapping.sourceScope.locationId === location.sourceScope.locationId &&
    mapping.targetScope.tenantId === location.targetScope.tenantId &&
    mapping.targetScope.clinicId === location.targetScope.clinicId &&
    mapping.targetScope.locationId === location.targetScope.locationId &&
    mapping.timeZone === location.timeZone && mapping.mappingProvenance === location.mappingProvenance));
}

/** Re-exports the frozen source; route publication must later recheck this fence version under its own lock. */
export async function comparePostgresFencedTenantArchiveSource(db: Kysely<Database>, baseline: ArchiveEnvelope,
  comparison: TenantConfigArchiveRequest & Readonly<{ expectedFenceVersion: number }>,
  authority: TenantConfigArchiveAuthority): Promise<Result<FencedArchiveComparison, FencedArchiveComparisonFailure>> {
  if (!Number.isSafeInteger(comparison?.expectedFenceVersion) || comparison.expectedFenceVersion < 1 ||
      !validTenantConfigArchiveRequest(comparison) || !authority || typeof authority.authorizeAndRecord !== "function") {
    return err({ kind: "invalidConfig" });
  }
  let authorized: Awaited<ReturnType<TenantConfigArchiveAuthority["authorizeAndRecord"]>>;
  try { authorized = await authority.authorizeAndRecord(comparison); }
  catch { return err({ kind: "auditFailure" }); }
  if (!authorized.ok) return err({ kind: authorized.error.kind });
  const targetTenantId = comparison.locations[0]!.targetScope.tenantId;
  const previous = await decodeTenantConfigArchive(baseline, targetTenantId);
  if (!previous.ok) return previous;
  if (previous.value.archiveId === comparison.archiveId) return err({ kind: "archiveIdReused" });
  if (previous.value.sourceTenantId !== comparison.sourceTenantId ||
      previous.value.sourceFenceVersion !== comparison.expectedFenceVersion ||
      !sameMappings(previous.value, comparison)) return err({ kind: "baselineMismatch" });
  const fresh = await buildPostgresFencedTenantConfigArchive(db, comparison,
    { authorizeAndRecord: async () => authorized });
  if (!fresh.ok) return fresh;
  const current = await decodeTenantConfigArchive(fresh.value, targetTenantId);
  if (!current.ok) return current;
  const changed: (ArchiveSection | "sourceSchema" | "omittedCalls")[] = [];
  if (previous.value.sourceSchemaVersion !== current.value.sourceSchemaVersion) changed.push("sourceSchema");
  if (previous.value.omittedCalls.notRetained !== current.value.omittedCalls.notRetained) changed.push("omittedCalls");
  for (const section of ["locations", "settings", "knowledge", "calls", "staffWork"] as const) {
    const before = previous.value.sectionManifests[section];
    const after = current.value.sectionManifests[section];
    if (before.recordCount !== after.recordCount || before.byteCount !== after.byteCount || before.sha256 !== after.sha256) {
      changed.push(section);
    }
  }
  return ok({ kind: changed.length ? "changed" : "unchanged",
    baselineArchiveId: previous.value.archiveId, baselineManifestDigest: previous.value.manifestDigest,
    comparisonArchiveId: current.value.archiveId, comparisonManifestDigest: current.value.manifestDigest,
    sourceFenceVersion: comparison.expectedFenceVersion, changed });
}
