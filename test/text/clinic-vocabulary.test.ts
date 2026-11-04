import assert from "node:assert/strict";
import test from "node:test";
import { currentVocabularyTerms, proposeClinicVocabulary, reviewClinicVocabulary, validClinicVocabulary,
  validVocabularyTerms, vocabularyRevision } from "../../src/core/clinic-vocabulary.ts";
import type { ClinicVocabulary, PublicVocabularyCatalogue } from "../../src/core/clinic-vocabulary.ts";

const scope = { tenantId: "synthetic", clinicId: "clinic", locationId: "main" };
function source(): PublicVocabularyCatalogue {
  return { scope, version: "catalogue.v1", complete: true, approvedPublicRefs: ["service-a", "location-a", "practitioner-a"], items: [
    { ref: "service-a", kind: "service", publicText: "  Physiotherapy  initial " },
    { ref: "location-a", kind: "location", publicText: "North Sydney" },
    { ref: "practitioner-a", kind: "practitioner", publicText: "Synthetic Clinician" },
    { ref: "unapproved", kind: "service", publicText: "UNREVIEWED DO NOT EXTRACT" },
  ] };
}
function proposal(catalogue = source(), prior?: ClinicVocabulary) {
  const found = proposeClinicVocabulary(catalogue, prior); assert.ok(found.ok); return found.value;
}
function review(catalogue = source(), prior?: ClinicVocabulary, terms = proposal(catalogue, prior).suggestions,
  manualPublicTerms: readonly string[] = []) {
  const p = proposal(catalogue, prior);
  const found = reviewClinicVocabulary(catalogue, prior, { expectedRevision: p.expectedRevision,
    catalogueHash: p.catalogueHash, selectedTerms: terms, manualPublicTerms });
  assert.ok(found.ok); return found.value;
}

test("clinic vocabulary extracts only explicitly public whitelisted fields and canonicalizes catalogue order", () => {
  const first = source(), p = proposal(first);
  assert.deepEqual(p.suggestions, ["North Sydney", "Synthetic Clinician", "Physiotherapy initial"]);
  const reordered = { ...first, items: [...first.items].reverse(), approvedPublicRefs: [...first.approvedPublicRefs].reverse() };
  assert.deepEqual(proposal(reordered), p);
  assert.equal(p.suggestions.some(term => term.includes("UNREVIEWED")), false);
  for (const malformed of [{ ...first, complete: false }, { ...first, companyInfo: "private free text" },
    { ...first, approvedPublicRefs: [...first.approvedPublicRefs, "missing"] },
    { ...first, items: [...first.items, first.items[0]] }, { ...first, items: new Array(1) },
    { ...first, scope: { ...scope, clinicId: "" } }]) {
    assert.equal(proposeClinicVocabulary(malformed as PublicVocabularyCatalogue).ok, false);
  }
});

test("vocabulary proposals preserve manual edits and removals across source refresh and process serialization", () => {
  const first = review(source(), undefined, ["North Sydney", "Physiotherapy initial"], ["Public clinic alias"]);
  const edited = review(source(), first, ["Physiotherapy initial"], ["Published revised alias"]);
  const restored = JSON.parse(JSON.stringify(edited)) as ClinicVocabulary;
  assert.ok(validClinicVocabulary(restored));
  const changed = { ...source(), version: "catalogue.v2" };
  const next = proposal(changed, restored);
  assert.deepEqual(next.manualTerms, ["Published revised alias"]);
  assert.deepEqual(next.selectedTerms, ["Physiotherapy initial"]);
  assert.deepEqual(next.suggestions, ["Synthetic Clinician"]);
  assert.deepEqual(restored.removedTerms, ["Public clinic alias", "North Sydney"]);
  assert.equal(currentVocabularyTerms(changed, restored).ok, false);
  const rereviewed = review(changed, restored, next.selectedTerms, next.manualTerms);
  assert.deepEqual(currentVocabularyTerms(changed, rereviewed), { ok: true, value: ["Published revised alias", "Physiotherapy initial"] });
  const explicitlyRestored = review(changed, rereviewed, ["North Sydney", "Physiotherapy initial"], next.manualTerms);
  assert.equal(explicitlyRestored.removedTerms.includes("North Sydney"), false);
});

test("vocabulary review refuses stale content, publication approval, tenant and exact saved revisions", () => {
  const catalogue = source(), saved = review(catalogue), p = proposal(catalogue, saved);
  const input = { expectedRevision: p.expectedRevision, catalogueHash: p.catalogueHash,
    manualPublicTerms: [], selectedTerms: p.selectedTerms };
  const changed = { ...catalogue, items: catalogue.items.map(item => item.ref === "service-a" ? { ...item, publicText: "Changed service" } : item) };
  assert.equal(reviewClinicVocabulary(changed, saved, input).ok, false);
  assert.equal(reviewClinicVocabulary({ ...catalogue, approvedPublicRefs: ["service-a"] }, saved, input).ok, false);
  const other = review(catalogue, saved, [], ["Explicit public term"]);
  assert.equal(reviewClinicVocabulary(catalogue, other, input).ok, false);
  assert.equal(proposeClinicVocabulary({ ...catalogue, scope: { ...scope, clinicId: "other" } }, saved).ok, false);
  assert.equal(currentVocabularyTerms(catalogue, { ...saved, selectedTerms: ["Tampered"] }).ok, false);
  assert.equal(reviewClinicVocabulary(catalogue, saved, { ...input, selectedTerms: ["UNREVIEWED DO NOT EXTRACT"] }).ok, false);
  assert.equal(currentVocabularyTerms(changed, saved).ok, false);
  const back = review(catalogue, other, saved.selectedTerms, saved.manualTerms);
  assert.notEqual(back.revision, saved.revision, "returning to old terms cannot revive an old editor revision");
  assert.equal(Number(back.version), Number(saved.version) + 2);
});

test("vocabulary caps are deterministic and never silently remove an owner's manual terms", () => {
  const catalogue: PublicVocabularyCatalogue = { scope, version: "large.v1", complete: true,
    items: Array.from({ length: 100 }, (_, i) => ({ ref: `service-${String(i).padStart(3, "0")}`, kind: "service", publicText: `Term ${i}` })),
    approvedPublicRefs: Array.from({ length: 100 }, (_, i) => `service-${String(i).padStart(3, "0")}`) };
  const p = proposal(catalogue); assert.equal(p.suggestions.length, 50);
  const first = review(catalogue, undefined, p.suggestions.slice(0, 48), ["Manual alpha", "Manual beta"]);
  const next = proposal(catalogue, first); assert.equal(next.suggestions.length, 0);
  assert.deepEqual(next.manualTerms, ["Manual alpha", "Manual beta"]);
  for (const terms of [["a", "A"], ["weighted:3"], [" a"], ["a,b"], ["a\n"], ["x".repeat(81)],
    new Array(1), Array.from({ length: 51 }, (_, i) => `t${i}`), Array.from({ length: 20 }, (_, i) => `${i}${"界".repeat(30)}`)]) {
    assert.equal(validVocabularyTerms(terms), false);
  }
  assert.ok(validVocabularyTerms([]));
});

test("a changed public spelling is proposed for review while manual spellings and deletion choices persist", () => {
  const original = source(), saved = review(original, undefined, ["North Sydney"], ["Owner's published spelling"]);
  const changed = { ...original, items: original.items.map(item => item.ref === "location-a"
    ? { ...item, publicText: "NORTH SYDNEY" } : item) };
  const next = proposal(changed, saved);
  assert.deepEqual(next.selectedTerms, ["NORTH SYDNEY"]);
  assert.deepEqual(next.manualTerms, ["Owner's published spelling"]);
  assert.equal(currentVocabularyTerms(changed, saved).ok, false);
  const accepted = review(changed, saved, next.selectedTerms, next.manualTerms);
  assert.deepEqual(currentVocabularyTerms(changed, accepted), { ok: true, value: ["Owner's published spelling", "NORTH SYDNEY"] });
});

test("a syntactically valid provisioned selection cannot bypass the current public catalogue whitelist", () => {
  const catalogue = source(), saved = review(catalogue);
  const draft = { ...saved, selectedTerms: ["UNREVIEWED DO NOT EXTRACT"] };
  const provisioned = { ...draft, revision: vocabularyRevision(draft) };
  assert.equal(validClinicVocabulary(provisioned), true);
  assert.equal(currentVocabularyTerms(catalogue, provisioned).ok, false);
});
