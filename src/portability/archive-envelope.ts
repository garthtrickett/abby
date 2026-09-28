import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";

export const ARCHIVE_SECTIONS = ["locations", "settings", "knowledge", "calls", "staffWork"] as const;
export type ArchiveSection = typeof ARCHIVE_SECTIONS[number];

export type ArchiveSectionManifest = Readonly<{
  version: 1;
  recordCount: number;
  byteCount: number;
  sha256: string;
}>;

export type ArchiveManifestV1 = Readonly<{
  archiveVersion: 1;
  archiveId: string;
  createdAt: string;
  sourceSystem: string;
  sourceSchemaVersion: string;
  sourceTenantId: string;
  sections: Readonly<Record<ArchiveSection, ArchiveSectionManifest>>;
}>;

/** A section opener must return a fresh stream for a later semantic preflight/import pass. */
export type ArchiveEnvelope = Readonly<{
  manifestBytes: Uint8Array;
  sections: Readonly<Record<ArchiveSection, () => AsyncIterable<Uint8Array>>>;
}>;

export type ArchiveEnvelopeFailure = Readonly<{
  kind: "invalidManifest" | "unsupportedVersion" | "invalidSection" | "digestMismatch" |
    "countMismatch" | "scopeMismatch" | "duplicateOrUnsorted" | "readFailure" | "tooLarge";
  section?: ArchiveSection;
}>;

export type VerifiedArchiveEnvelope = Readonly<{
  manifest: ArchiveManifestV1;
  manifestDigest: string;
}>;

export type MaterializedArchiveEnvelope = Readonly<{
  verified: VerifiedArchiveEnvelope;
  manifestBytes: Uint8Array;
  sections: Readonly<Record<ArchiveSection, Uint8Array>>;
}>;

const sha256 = /^[a-f0-9]{64}$/;
const maxManifestBytes = 64 * 1024;
const maxRecordBytes = 1024 * 1024;
const processingWindowBytes = 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validManifest(value: unknown): Result<ArchiveManifestV1, ArchiveEnvelopeFailure> {
  const manifest = object(value);
  if (!manifest) return err({ kind: "invalidManifest" });
  if (manifest.archiveVersion !== 1) return err({ kind: "unsupportedVersion" });
  if (!nonempty(manifest.archiveId) || !nonempty(manifest.sourceSystem) ||
      !nonempty(manifest.sourceSchemaVersion) || !nonempty(manifest.sourceTenantId) ||
      typeof manifest.createdAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(manifest.createdAt) ||
      !Number.isFinite(Date.parse(manifest.createdAt))) return err({ kind: "invalidManifest" });
  const sections = object(manifest.sections);
  if (!sections || Object.keys(sections).length !== ARCHIVE_SECTIONS.length ||
      ARCHIVE_SECTIONS.some(name => !Object.hasOwn(sections, name))) return err({ kind: "invalidManifest" });
  for (const name of ARCHIVE_SECTIONS) {
    const section = object(sections[name]);
    if (!section || section.version !== 1 || !Number.isSafeInteger(section.recordCount) || Number(section.recordCount) < 0 ||
        !Number.isSafeInteger(section.byteCount) || Number(section.byteCount) < 0 ||
        typeof section.sha256 !== "string" || !sha256.test(section.sha256)) {
      return err({ kind: section?.version !== undefined && section.version !== 1 ? "unsupportedVersion" : "invalidManifest", section: name });
    }
  }
  return ok(manifest as ArchiveManifestV1);
}

function recordLine(bytes: Buffer, tenantId: string, previousId: Buffer | undefined, section: ArchiveSection):
  Result<Buffer, ArchiveEnvelopeFailure> {
  if (bytes.byteLength === 0 || bytes.byteLength > maxRecordBytes) return err({ kind: "invalidSection", section });
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(bytes)); }
  catch { return err({ kind: "invalidSection", section }); }
  const record = object(parsed);
  if (!record || !nonempty(record.recordId)) return err({ kind: "invalidSection", section });
  if (record.recordVersion !== 1) return err({ kind: "unsupportedVersion", section });
  if (record.sourceTenantId !== tenantId) return err({ kind: "scopeMismatch", section });
  const id = Buffer.from(record.recordId, "utf8");
  if (previousId && Buffer.compare(id, previousId) <= 0) return err({ kind: "duplicateOrUnsorted", section });
  return ok(id);
}

async function verifySection(section: ArchiveSection, expected: ArchiveSectionManifest, tenantId: string,
                             open: () => AsyncIterable<Uint8Array>): Promise<Result<true, ArchiveEnvelopeFailure>> {
  const hash = createHash("sha256");
  let byteCount = 0;
  let recordCount = 0;
  let pending = Buffer.alloc(0);
  let previousId: Buffer | undefined;
  try {
    for await (const part of open()) {
      if (!(part instanceof Uint8Array)) return err({ kind: "invalidSection", section });
      byteCount += part.byteLength;
      if (!Number.isSafeInteger(byteCount) || byteCount > expected.byteCount) return err({ kind: "countMismatch", section });
      hash.update(part);
      for (let partOffset = 0; partOffset < part.byteLength; partOffset += processingWindowBytes) {
        const chunk = Buffer.concat([pending, Buffer.from(part.subarray(partOffset, partOffset + processingWindowBytes))]);
        let offset = 0;
        for (let newline = chunk.indexOf(10, offset); newline !== -1; newline = chunk.indexOf(10, offset)) {
          const checked = recordLine(chunk.subarray(offset, newline), tenantId, previousId, section);
          if (!checked.ok) return checked;
          previousId = checked.value;
          recordCount += 1;
          if (recordCount > expected.recordCount) return err({ kind: "countMismatch", section });
          offset = newline + 1;
        }
        pending = chunk.subarray(offset);
        if (pending.byteLength > maxRecordBytes) return err({ kind: "invalidSection", section });
      }
    }
  } catch { return err({ kind: "readFailure", section }); }
  if (pending.byteLength !== 0) return err({ kind: "invalidSection", section });
  if (byteCount !== expected.byteCount || recordCount !== expected.recordCount) return err({ kind: "countMismatch", section });
  if (hash.digest("hex") !== expected.sha256) return err({ kind: "digestMismatch", section });
  return ok(true);
}

/** Verifies transport integrity and common scope fields; a semantic importer must validate every section's payload. */
export async function verifyArchiveEnvelope(input: ArchiveEnvelope): Promise<Result<VerifiedArchiveEnvelope, ArchiveEnvelopeFailure>> {
  if (!(input?.manifestBytes instanceof Uint8Array) || input.manifestBytes.byteLength > maxManifestBytes ||
      !input.sections || Object.keys(input.sections).length !== ARCHIVE_SECTIONS.length ||
      ARCHIVE_SECTIONS.some(name => typeof input.sections[name] !== "function")) {
    return err({ kind: "invalidManifest" });
  }
  const manifestBytes = Uint8Array.from(input.manifestBytes);
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(manifestBytes)); }
  catch { return err({ kind: "invalidManifest" }); }
  const manifest = validManifest(parsed);
  if (!manifest.ok) return manifest;
  for (const name of ARCHIVE_SECTIONS) {
    const checked = await verifySection(name, manifest.value.sections[name], manifest.value.sourceTenantId, input.sections[name]);
    if (!checked.ok) return checked;
  }
  return ok({ manifest: manifest.value, manifestDigest: createHash("sha256").update(manifestBytes).digest("hex") });
}

/** Retains precisely the bytes verified, so semantic import cannot read a changed stream on a second open. */
export async function materializeVerifiedArchive(input: ArchiveEnvelope): Promise<Result<MaterializedArchiveEnvelope, ArchiveEnvelopeFailure>> {
  if (!(input?.manifestBytes instanceof Uint8Array) || input.manifestBytes.byteLength > maxManifestBytes) return err({ kind: "invalidManifest" });
  const manifestBytes = Uint8Array.from(input.manifestBytes);
  const captured = Object.fromEntries(ARCHIVE_SECTIONS.map(name => [name, [] as Uint8Array[]])) as Record<ArchiveSection, Uint8Array[]>;
  let totalBytes = 0;
  let exceeded = false;
  const wrap = (name: ArchiveSection) => async function* () {
    for await (const chunk of input.sections[name]()) {
      if (chunk instanceof Uint8Array) {
        totalBytes += chunk.byteLength;
        if (totalBytes > 256 * 1024 * 1024) { exceeded = true; throw new Error("archive too large"); }
        captured[name].push(Uint8Array.from(chunk));
      }
      yield chunk;
    }
  };
  const wrapped = { locations: wrap("locations"), settings: wrap("settings"), knowledge: wrap("knowledge"),
    calls: wrap("calls"), staffWork: wrap("staffWork") };
  const verified = await verifyArchiveEnvelope({ manifestBytes, sections: wrapped });
  if (exceeded) return err({ kind: "tooLarge" });
  if (!verified.ok) return verified;
  const sections = { locations: Buffer.concat(captured.locations), settings: Buffer.concat(captured.settings),
    knowledge: Buffer.concat(captured.knowledge), calls: Buffer.concat(captured.calls), staffWork: Buffer.concat(captured.staffWork) };
  return ok({ verified: verified.value, manifestBytes, sections });
}
