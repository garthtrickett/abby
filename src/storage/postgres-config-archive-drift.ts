import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { ArchiveEnvelope, ArchiveSection } from "../portability/archive-envelope.ts";
import { decodeConfigArchive } from "../portability/config-archive.ts";
import type { ConfigArchiveDecodeFailure } from "../portability/config-archive.ts";
import { buildPostgresConfigArchive, validConfigArchiveRequest } from "./postgres-config-archive.ts";
import type { ConfigArchiveAuthority, ConfigArchiveFailure, ConfigArchiveRequest } from "./postgres-config-archive.ts";
import type Database from "./generated/Database.ts";

export type ConfigArchiveDriftFailure = ConfigArchiveFailure | ConfigArchiveDecodeFailure | Readonly<{
  kind: "baselineMismatch" | "archiveIdReused";
}>;

export type ConfigArchiveDriftReport = Readonly<{
  kind: "unchanged" | "changed";
  baselineArchiveId: string;
  baselineManifestDigest: string;
  comparisonArchiveId: string;
  comparisonManifestDigest: string;
  changed: readonly (ArchiveSection | "sourceSchema" | "omittedCalls")[];
}>;

function sameScope(left: ConfigArchiveRequest["scope"], right: ConfigArchiveRequest["scope"]): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

/** Compares two audited, consistent snapshots. A matching result is not a quiescence or route-switch fence. */
export async function comparePostgresConfigArchiveSource(db: Kysely<Database>, baseline: ArchiveEnvelope,
                                                         comparison: ConfigArchiveRequest, authority: ConfigArchiveAuthority):
  Promise<Result<ConfigArchiveDriftReport, ConfigArchiveDriftFailure>> {
  if (!validConfigArchiveRequest(comparison) || !authority || typeof authority.authorizeAndRecord !== "function") {
    return err({ kind: "invalidConfig" });
  }
  let authorization: Awaited<ReturnType<ConfigArchiveAuthority["authorizeAndRecord"]>>;
  try { authorization = await authority.authorizeAndRecord(comparison); }
  catch { return err({ kind: "auditFailure" }); }
  if (!authorization.ok) return err({ kind: authorization.error.kind });
  const previous = await decodeConfigArchive(baseline, comparison.targetScope);
  if (!previous.ok) return previous;
  if (previous.value.archiveId === comparison.archiveId) return err({ kind: "archiveIdReused" });
  if (!sameScope(previous.value.sourceScope, comparison.scope) ||
      previous.value.timeZone !== comparison.timeZone || previous.value.mappingProvenance !== comparison.mappingProvenance) {
    return err({ kind: "baselineMismatch" });
  }
  const currentArchive = await buildPostgresConfigArchive(db, comparison,
    { authorizeAndRecord: async () => authorization });
  if (!currentArchive.ok) return currentArchive;
  const current = await decodeConfigArchive(currentArchive.value, comparison.targetScope);
  if (!current.ok) return current;
  const changed: (ArchiveSection | "sourceSchema" | "omittedCalls")[] = [];
  if (previous.value.sourceSchemaVersion !== current.value.sourceSchemaVersion) changed.push("sourceSchema");
  if (previous.value.omittedCalls.notRetained !== current.value.omittedCalls.notRetained) changed.push("omittedCalls");
  for (const section of ["locations", "settings", "knowledge", "calls", "staffWork"] as const) {
    const before = previous.value.sectionManifests[section];
    const after = current.value.sectionManifests[section];
    if (before.version !== after.version || before.recordCount !== after.recordCount ||
        before.byteCount !== after.byteCount || before.sha256 !== after.sha256) {
      changed.push(section);
    }
  }
  return ok({ kind: changed.length ? "changed" : "unchanged", baselineArchiveId: previous.value.archiveId,
    baselineManifestDigest: previous.value.manifestDigest, comparisonArchiveId: current.value.archiveId,
    comparisonManifestDigest: current.value.manifestDigest, changed });
}
