import { createHash } from "node:crypto";
import { materializeVerifiedArchive } from "../../src/portability/archive-envelope.ts";
import type { ArchiveEnvelope, ArchiveSection } from "../../src/portability/archive-envelope.ts";
import { value } from "./voice-settings-contract.ts";

/** Reseal an intentionally malformed settings section so semantic validation, not its digest, rejects it. */
export async function editSettingsArchive(input: ArchiveEnvelope,
  edit: (rows: Record<string, unknown>[]) => Record<string, unknown>[]): Promise<ArchiveEnvelope> {
  const archive = value(await materializeVerifiedArchive(input)), parts = { ...archive.sections };
  const rows = Buffer.from(parts.settings).toString().trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const next = edit(rows); parts.settings = Buffer.from(next.map(row => JSON.stringify(row)).join("\n") + "\n");
  const manifest = JSON.parse(Buffer.from(archive.manifestBytes).toString()) as {
    sections: Record<string, { recordCount: number; byteCount: number; sha256: string }> };
  manifest.sections.settings = { ...manifest.sections.settings, recordCount: next.length, byteCount: parts.settings.byteLength,
    sha256: createHash("sha256").update(parts.settings).digest("hex") };
  const section = (name: ArchiveSection) => async function* () { yield parts[name]; };
  return { manifestBytes: Buffer.from(JSON.stringify(manifest)), sections: { locations: section("locations"), settings: section("settings"),
    knowledge: section("knowledge"), calls: section("calls"), staffWork: section("staffWork") } };
}
