import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assessClinicAcceptance, clinicSetupAreas, prepareClinicAcceptance } from "../../src/standalone/clinic-acceptance-workbook.ts";
import type { ClinicTrialBinding } from "../../src/standalone/clinic-acceptance-workbook.ts";
import { readClinicTrialBinding, runClinicAcceptance } from "../../scripts/clinic-acceptance.ts";

const now = "2026-10-24T10:00:00.000Z", later = "2026-10-24T11:00:00.000Z";
const binding: ClinicTrialBinding = { sourceCommit: "a".repeat(40), scope: { tenantId: "tenant", clinicId: "clinic", locationId: "main" }, country: "AU",
  configuration: { catalogue: "b".repeat(64), cancellation: "c".repeat(64), rescheduling: "a".repeat(64), payments: "d".repeat(64), staff: "e".repeat(64), memos: "f".repeat(64) } };
const completed = () => {
  const workbook = prepareClinicAcceptance(binding, now);
  return { ...workbook, observations: workbook.observations.map(o => ({ ...o, status: "passed" as const,
    observerRef: "clinic_staff_1", observedAt: later, evidenceRef: `evidence-${"a".repeat(32)}` })) };
};

test("clinic trial starts unperformed and even a fully observed worksheet grants no activation", () => {
  const prepared = prepareClinicAcceptance(binding, now);
  assert.equal(assessClinicAcceptance(prepared, binding, later).status, "incomplete");
  const summary = assessClinicAcceptance(completed(), binding, later);
  assert.equal(summary.status, "observationsRecorded");
  assert.equal(summary.activationAuthorized, false);
  assert.ok("passed" in summary); assert.equal(summary.passed, 12);
  assert.equal(summary.evidenceBasis, "selfReportedStaffObservations");
  assert.equal(JSON.stringify(summary).includes("clinic_staff_1"), false);
});

test("trial source, every configuration area, clinic scope and country changes invalidate earlier observations", () => {
  const workbook = completed();
  for (const changed of [{ ...binding, sourceCommit: "b".repeat(40) }, { ...binding, country: "NZ" as const },
    ...["tenantId", "clinicId", "locationId"].map(key => ({ ...binding, scope: { ...binding.scope, [key]: "other" } })),
    ...clinicSetupAreas.map(area => ({ ...binding, configuration: { ...binding.configuration, [area]: "1".repeat(64) } }))]) {
    assert.equal(assessClinicAcceptance(workbook, changed, later).status, "stale");
  }
  const reordered = { ...binding, configuration: Object.fromEntries(Object.entries(binding.configuration).reverse()) as ClinicTrialBinding["configuration"] };
  assert.equal(assessClinicAcceptance(workbook, reordered, later).status, "observationsRecorded");
});

test("missing clinic configuration is visible and is never treated as an approved no-deposit or memo policy", () => {
  const incomplete = { ...binding, configuration: { ...binding.configuration, payments: null, memos: null } };
  const workbook = prepareClinicAcceptance(incomplete, now);
  const summary = assessClinicAcceptance(workbook, incomplete, later);
  assert.equal(summary.status, "configurationIncomplete");
  assert.ok("missingConfiguration" in summary); assert.deepEqual(summary.missingConfiguration, ["payments", "memos"]);
});

test("failed trials, duplicate/omitted cases, future observations and private free text cannot count as completion", () => {
  const workbook = completed(), first = workbook.observations[0]!;
  assert.equal(assessClinicAcceptance({ ...workbook, observations: [{ ...first, status: "failed" }, ...workbook.observations.slice(1)] }, binding, later).status, "failed");
  for (const changed of [
    { ...workbook, observations: workbook.observations.slice(1) },
    { ...workbook, observations: [...workbook.observations.slice(0, -1), ,] },
    { ...workbook, observations: [workbook.observations[1], ...workbook.observations.slice(1)] },
    { ...workbook, observations: [{ ...first, status: "skipped" }, ...workbook.observations.slice(1)] },
    { ...workbook, observations: [{ ...first, observedAt: "2026-10-24T11:00:00.001Z" }, ...workbook.observations.slice(1)] },
    { ...workbook, observations: [{ ...first, observedAt: "2026-10-24T09:59:59.999Z" }, ...workbook.observations.slice(1)] },
    { ...workbook, observations: [{ ...first, evidenceRef: "patient@example.test" }, ...workbook.observations.slice(1)] },
    { ...workbook, observations: [{ ...first, notes: "private patient detail" }, ...workbook.observations.slice(1)] },
    { ...workbook, observations: [{ ...first, status: "notRun" }, ...workbook.observations.slice(1)] },
    { ...workbook, preparedAt: "2026-02-30T10:00:00.000Z" },
  ]) assert.equal(assessClinicAcceptance(changed, binding, later).status, "unavailable");
});

test("preparing a trial snapshots inputs instead of inheriting later mutable clinic changes", () => {
  const input = structuredClone(binding), workbook = prepareClinicAcceptance(input, now);
  (input.scope as { clinicId: string }).clinicId = "other";
  assert.equal(workbook.binding.scope.clinicId, "clinic");
});

test("worksheet CLI rejects unsafe configuration and malformed commands without provider access or output writes", async () => {
  const folder = await mkdtemp(join(tmpdir(), "abby-clinic-workbook-"));
  try {
    const path = join(folder, "config.json"), out = join(folder, "out.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, scope: binding.scope, country: "AU", files:
      { catalogue: null, cancellation: null, rescheduling: null, payments: null, staff: null, memos: null } }), { mode: 0o600 });
    await chmod(path, 0o644); await assert.rejects(readClinicTrialBinding(path));
    await chmod(path, 0o600); await symlink(path, `${path}.link`); await assert.rejects(readClinicTrialBinding(`${path}.link`));
    for (const args of [[], ["prepare", `--config=${path}`, `--out=${out}`, "--enable"], ["check", `--config=${path}`, "--report=relative.json"]])
      await assert.rejects(runClinicAcceptance(args));
    await assert.rejects(readFile(out));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("worksheet CLI prepares owner-only evidence without overwrite and detects changed real configuration files", async () => {
  const folder = await mkdtemp(join(tmpdir(), "abby-clinic-workbook-live-files-"));
  try {
    const config = join(folder, "config.json"), out = join(folder, "report.json");
    const files = Object.fromEntries(clinicSetupAreas.map(area => [area, join(folder, `${area}.json`)]));
    for (const path of Object.values(files)) await writeFile(path, JSON.stringify({ revision: "test-config-1" }), { mode: 0o600 });
    await writeFile(config, JSON.stringify({ schemaVersion: 1, scope: binding.scope, country: "AU", files }), { mode: 0o600 });
    assert.equal((await runClinicAcceptance(["prepare", `--config=${config}`, `--out=${out}`])).status, "incomplete");
    const report = JSON.parse(await readFile(out, "utf8"));
    const bytes = await readFile(out);
    assert.equal(report.observations.length, 12);
    assert.equal(bytes.includes(Buffer.from(folder)), false, "configuration paths stay out of the worksheet");
    await assert.rejects(runClinicAcceptance(["prepare", `--config=${config}`, `--out=${out}`]));
    assert.deepEqual(await readFile(out), bytes);
    assert.equal((await runClinicAcceptance(["check", `--config=${config}`, `--report=${out}`])).status, "incomplete");
    await writeFile(files.staff!, JSON.stringify({ revision: "test-config-2" }));
    assert.equal((await runClinicAcceptance(["check", `--config=${config}`, `--report=${out}`])).status, "stale");
    await writeFile(files.staff!, JSON.stringify({ revision: "test-config-1" }));
    await writeFile(files.rescheduling!, JSON.stringify({ revision: "test-move-config-2" }));
    assert.equal((await runClinicAcceptance(["check", `--config=${config}`, `--report=${out}`])).status, "stale");
    await chmod(out, 0o644);
    await assert.rejects(runClinicAcceptance(["check", `--config=${config}`, `--report=${out}`]));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
