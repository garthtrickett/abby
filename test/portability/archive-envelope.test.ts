import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ARCHIVE_SECTIONS, materializeVerifiedArchive, verifyArchiveEnvelope } from "../../src/portability/archive-envelope.ts";
import type { ArchiveEnvelope, ArchiveManifestV1, ArchiveSection } from "../../src/portability/archive-envelope.ts";

function archive(records: Partial<Record<ArchiveSection, readonly Record<string, unknown>[]>> = {}): ArchiveEnvelope {
  const bytes = Object.fromEntries(ARCHIVE_SECTIONS.map(name => [name, Buffer.from(
    (records[name] ?? [{ recordVersion: 1, recordId: "a", sourceTenantId: "tenant-1" }])
      .map(row => `${JSON.stringify(row)}\n`).join(""), "utf8")])) as Record<ArchiveSection, Buffer>;
  const manifest: ArchiveManifestV1 = {
    archiveVersion: 1, archiveId: "archive-1", createdAt: "2026-09-28T00:00:00Z",
    sourceSystem: "reference", sourceSchemaVersion: "10", sourceTenantId: "tenant-1",
    sections: Object.fromEntries(ARCHIVE_SECTIONS.map(name => [name, {
      version: 1, recordCount: records[name]?.length ?? 1, byteCount: bytes[name].byteLength,
      sha256: createHash("sha256").update(bytes[name]).digest("hex"),
    }])) as ArchiveManifestV1["sections"],
  };
  function section(name: ArchiveSection): () => AsyncIterable<Uint8Array> {
    return async function* () {
      const content = bytes[name];
      for (let offset = 0; offset < content.byteLength; offset += 7) yield content.subarray(offset, offset + 7);
    };
  }
  return {
    manifestBytes: Buffer.from(JSON.stringify(manifest)),
    sections: { locations: section("locations"), settings: section("settings"), knowledge: section("knowledge"),
      calls: section("calls"), staffWork: section("staffWork") },
  };
}

test("archive envelope verifies all five streamed sections and their exact byte digests", async () => {
  const input = archive({ calls: [
    { recordVersion: 1, recordId: "a", sourceTenantId: "tenant-1", callId: "call-1" },
    { recordVersion: 1, recordId: "b", sourceTenantId: "tenant-1", callId: "call-2" },
  ] });
  const result = await verifyArchiveEnvelope(input);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.manifest.sections.calls.recordCount, 2);
    assert.equal(result.value.manifestDigest, createHash("sha256").update(input.manifestBytes).digest("hex"));
  }
});

test("archive envelope rejects altered bytes under an otherwise valid manifest", async () => {
  const input = archive();
  const corrupted = { ...input, sections: { ...input.sections,
    calls: async function* () { yield Buffer.from('{"recordVersion":1,"recordId":"b","sourceTenantId":"tenant-1"}\n'); },
  } };
  const result = await verifyArchiveEnvelope(corrupted);
  assert.deepEqual(result, { ok: false, error: { kind: "digestMismatch", section: "calls" } });
});

test("archive envelope rejects duplicate IDs and cross-tenant records even with matching digests", async () => {
  const duplicate = await verifyArchiveEnvelope(archive({ staffWork: [
    { recordVersion: 1, recordId: "a", sourceTenantId: "tenant-1" },
    { recordVersion: 1, recordId: "a", sourceTenantId: "tenant-1" },
  ] }));
  assert.deepEqual(duplicate, { ok: false, error: { kind: "duplicateOrUnsorted", section: "staffWork" } });
  const crossTenant = await verifyArchiveEnvelope(archive({ knowledge: [
    { recordVersion: 1, recordId: "a", sourceTenantId: "tenant-2" },
  ] }));
  assert.deepEqual(crossTenant, { ok: false, error: { kind: "scopeMismatch", section: "knowledge" } });
});

test("archive envelope rejects unknown versions, truncated records, and unreadable streams", async () => {
  const input = archive();
  const version = { ...input, manifestBytes: Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(input.manifestBytes).toString()), archiveVersion: 2 })) };
  assert.deepEqual(await verifyArchiveEnvelope(version), { ok: false, error: { kind: "unsupportedVersion" } });
  const truncated = { ...input, sections: { ...input.sections, locations: async function* () {
    yield Buffer.from('{"recordVersion":1,"recordId":"a","sourceTenantId":"tenant-1"}');
  } } };
  assert.deepEqual(await verifyArchiveEnvelope(truncated), { ok: false, error: { kind: "invalidSection", section: "locations" } });
  const unreadable = { ...input, sections: { ...input.sections, settings: async function* (): AsyncIterable<Uint8Array> {
    throw new Error("disk failed");
  } } };
  assert.deepEqual(await verifyArchiveEnvelope(unreadable), { ok: false, error: { kind: "readFailure", section: "settings" } });
});

test("archive envelope rejects a matching digest with a false record count or record version", async () => {
  const input = archive();
  const manifest = JSON.parse(Buffer.from(input.manifestBytes).toString());
  manifest.sections.calls.recordCount = 2;
  assert.deepEqual(await verifyArchiveEnvelope({ ...input, manifestBytes: Buffer.from(JSON.stringify(manifest)) }),
    { ok: false, error: { kind: "countMismatch", section: "calls" } });
  const future = await verifyArchiveEnvelope(archive({ settings: [
    { recordVersion: 2, recordId: "a", sourceTenantId: "tenant-1" },
  ] }));
  assert.deepEqual(future, { ok: false, error: { kind: "unsupportedVersion", section: "settings" } });
});

test("materialization preserves the bytes verified even if a section opener would change on replay", async () => {
  const input = archive();
  const original = input.sections.calls;
  let opens = 0;
  const volatile = { ...input, sections: { ...input.sections, calls: () => {
    opens += 1;
    return opens === 1 ? original() : (async function* () { yield Buffer.from("changed\n"); })();
  } } };
  const result = await materializeVerifiedArchive(volatile);
  assert.equal(result.ok, true);
  assert.equal(opens, 1);
  if (result.ok) assert.match(Buffer.from(result.value.sections.calls).toString(), /"recordId":"a"/);
});
