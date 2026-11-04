import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../../src/core/model.ts";
import { proposeClinicVocabulary, reviewClinicVocabulary } from "../../src/core/clinic-vocabulary.ts";
import type { PublicVocabularyCatalogue } from "../../src/core/clinic-vocabulary.ts";
import type { ClinicVocabularyApproval, PublicVocabularyCatalogueReader } from "../../src/standalone/owner-file-clinic-vocabulary.ts";
import type { AdminAccount, AdminDirectory } from "../../src/standalone/identity/magic-link.ts";
export const vocabularyScope = { tenantId: "synthetic", clinicId: "main", locationId: "north" };
const scope = vocabularyScope;

export async function clinicVocabularyFixture() {
  const folder = await mkdtemp(join(tmpdir(), "abby-vocabulary-"));
  const path = join(folder, "public-vocabulary.json");
  let inventory: PublicVocabularyCatalogue = { scope, version: "inventory.v1", complete: true,
    items: [{ ref: "service", kind: "service", publicText: "Physiotherapy" },
      { ref: "unapproved", kind: "practitioner", publicText: "Unpublished Person" }], approvedPublicRefs: ["service"] };
  const proposal = proposeClinicVocabulary(inventory); assert.ok(proposal.ok);
  const reviewed = reviewClinicVocabulary(inventory, undefined, { ...proposal.value,
    manualPublicTerms: [], selectedTerms: proposal.value.suggestions });
  // The review input schema deliberately does not accept an echoed whole proposal.
  assert.equal(reviewed.ok, false);
  const saved = reviewClinicVocabulary(inventory, undefined, { expectedRevision: proposal.value.expectedRevision,
    catalogueHash: proposal.value.catalogueHash, manualPublicTerms: [], selectedTerms: proposal.value.suggestions });
  assert.ok(saved.ok);
  let row: ClinicVocabularyApproval = { scope, revision: "approval.v1", approverRef: "admin",
    approvedAt: "2026-11-03T00:00:00.000Z", effectiveFrom: "2026-11-03T00:00:00.000Z",
    effectiveUntil: "2026-11-05T00:00:00.000Z", approved: true, enabled: true, vocabulary: saved.value };
  let member: AdminAccount | undefined = { email: "synthetic@example.test", membershipVersion: "membership.v1",
    actor: { actorRef: "admin", role: "clinicAdmin", scope } };
  let onInventory: (() => Promise<void>) | undefined;
  const directory: AdminDirectory = { async findByRef() { return ok(member); }, async findByEmail() { return ok(member); } };
  const catalogue: PublicVocabularyCatalogueReader = { async current() {
    await onInventory?.(); return ok(structuredClone(inventory));
  } };
  const replace = async (patch: Partial<ClinicVocabularyApproval>) => {
    row = { ...row, ...patch }; await writeFile(path + ".next", JSON.stringify(row), { mode: 0o600 });
    await rename(path + ".next", path);
  };
  await replace({});
  const config = { path, scope, directory, catalogue, clock: () => "2026-11-04T00:00:00.000Z" };
  return { path, config, replace, get row() { return structuredClone(row); },
    changeInventory(value: PublicVocabularyCatalogue) { inventory = value; },
    get inventory() { return structuredClone(inventory); }, revoke() { member = undefined; },
    duringInventory(action: () => Promise<void>) { onInventory = action; },
    async close() { await rm(folder, { recursive: true, force: true }); } };
}
