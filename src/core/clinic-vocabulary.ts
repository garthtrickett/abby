import { createHash } from "node:crypto";
import { err, ok } from "./model.ts";
import type { LocationScope, Result } from "./model.ts";
import { validVoiceLocationScope, validVoiceRef, validVoiceVersion } from "./voice-profile.ts";

export type VocabularyFailure = Readonly<{ kind: "invalidVocabulary" | "staleVocabulary" }>;
export type PublicVocabularyItem = Readonly<{
  ref: string; kind: "service" | "practitioner" | "location" | "specialty"; publicText: string;
}>;
/** Trusted host inventory, never a caller/model-provided object. Completeness and
 * publication approval are independent assertions; neither follows from Cliniko membership. */
export type PublicVocabularyCatalogue = Readonly<{
  scope: LocationScope; version: string; complete: true;
  items: readonly PublicVocabularyItem[]; approvedPublicRefs: readonly string[];
}>;
export type ClinicVocabulary = Readonly<{
  scope: LocationScope; version: string; revision: string; catalogueHash: string;
  manualTerms: readonly string[]; selectedTerms: readonly string[]; removedTerms: readonly string[];
}>;
export type VocabularyProposal = Readonly<{
  scope: LocationScope; catalogueHash: string; expectedRevision: string;
  manualTerms: readonly string[]; selectedTerms: readonly string[]; suggestions: readonly string[];
}>;
const invalid = () => err({ kind: "invalidVocabulary" as const });
const stale = () => err({ kind: "staleVocabulary" as const });
const key = (term: string): string => term.toLowerCase();
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exact = (value: unknown, keys: string): value is Record<string, unknown> => !!value &&
  typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys;
const sameScope = (a: LocationScope, b: LocationScope): boolean => a.tenantId === b.tenantId &&
  a.clinicId === b.clinicId && a.locationId === b.locationId;
const scopeValue = (scope: LocationScope): readonly string[] => [scope.tenantId, scope.clinicId, scope.locationId];

/** Existing Nova-3 request limits. No coercion, weights, sparse arrays or silent truncation. */
export function validVocabularyTerms(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 50 && Array.from(value).every(term =>
    typeof term === "string" && !!term.trim() && term === term.trim() && term.length <= 80 &&
    !/[\u0000-\u001f\u007f,:;]/.test(term)) && Buffer.byteLength(value.join(" "), "utf8") <= 1_000 &&
    new Set(value.map(key)).size === value.length;
}

function catalogue(value: PublicVocabularyCatalogue): Readonly<{ hash: string; terms: readonly string[] }> | undefined {
  if (!exact(value, "approvedPublicRefs,complete,items,scope,version") || !validVoiceLocationScope(value.scope) ||
      !validVoiceRef(value.version) || value.complete !== true || !Array.isArray(value.items) || value.items.length > 128 ||
      !Array.isArray(value.approvedPublicRefs) || value.approvedPublicRefs.length > 128 ||
      !Array.from(value.approvedPublicRefs).every(validVoiceRef) ||
      new Set(value.approvedPublicRefs).size !== value.approvedPublicRefs.length) return undefined;
  const items = Array.from(value.items);
  if (!items.every(item => exact(item, "kind,publicText,ref") && validVoiceRef(item.ref) &&
      typeof item.kind === "string" && ["service", "practitioner", "location", "specialty"].includes(item.kind) &&
      typeof item.publicText === "string" && item.publicText.length > 0 && item.publicText.length <= 256 &&
      !/[\u0000-\u001f\u007f]/.test(item.publicText)) || new Set(items.map(item => item.ref)).size !== items.length ||
      value.approvedPublicRefs.some(ref => !items.some(item => item.ref === ref))) return undefined;
  // Whitelist before extracting terms. Free text/company descriptions/patient
  // fields are not accepted by this schema. A public practitioner display name
  // needs its own explicit publication approval like every other field.
  const publicItems = items.filter(item => value.approvedPublicRefs.includes(item.ref))
    .sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  const terms: string[] = [];
  for (const item of publicItems) {
    const term = item.publicText.trim().replace(/ +/g, " ");
    if (validVocabularyTerms([term]) && !terms.some(prior => key(prior) === key(term))) terms.push(term);
  }
  // Pin the complete source, including unselected rows. Changed publication
  // approval, content, identity or completeness must be reviewed again.
  const canonical = [...items].sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)
    .map(item => [item.ref, item.kind, item.publicText]);
  return { hash: digest([scopeValue(value.scope), value.version, canonical, [...value.approvedPublicRefs].sort()]), terms };
}

export function vocabularyRevision(value: Omit<ClinicVocabulary, "revision">): string {
  return digest([scopeValue(value.scope), value.version, value.catalogueHash, value.manualTerms, value.selectedTerms, value.removedTerms]);
}
export function validClinicVocabulary(value: unknown): value is ClinicVocabulary {
  if (!exact(value, "catalogueHash,manualTerms,removedTerms,revision,scope,selectedTerms,version") ||
      !validVoiceLocationScope(value.scope) || !validVoiceVersion(value.version) || !hash(value.catalogueHash) || !hash(value.revision) ||
      !validVocabularyTerms(value.manualTerms) || !validVocabularyTerms(value.selectedTerms) ||
      !Array.isArray(value.removedTerms) || value.removedTerms.length > 512 ||
      !Array.from(value.removedTerms).every(term => validVocabularyTerms([term])) ||
      new Set(value.removedTerms.map(key)).size !== value.removedTerms.length ||
      !validVocabularyTerms([...value.manualTerms, ...value.selectedTerms]) ||
      [...value.manualTerms, ...value.selectedTerms].some(term => (value.removedTerms as string[]).some(removed => key(term) === key(removed)))) return false;
  return value.revision === vocabularyRevision(value as unknown as ClinicVocabulary);
}

/** Read-only proposal. Existing manual edits keep their order; deleted automatic
 * suggestions never return on refresh. No proposal becomes provider configuration. */
export function proposeClinicVocabulary(source: PublicVocabularyCatalogue, prior?: ClinicVocabulary): Result<VocabularyProposal, VocabularyFailure> {
  const current = catalogue(source);
  if (!current || prior !== undefined && (!validClinicVocabulary(prior) || !sameScope(source.scope, prior.scope))) return invalid();
  const manualTerms = [...prior?.manualTerms ?? []];
  const selectedTerms = (prior?.selectedTerms ?? []).flatMap(term => {
    const candidate = current.terms.find(candidate => key(term) === key(candidate));
    return candidate === undefined ? [] : [candidate];
  });
  const used = [...manualTerms, ...selectedTerms];
  const suggestions: string[] = [];
  for (const term of current.terms) {
    if (used.some(prior => key(prior) === key(term)) || prior?.removedTerms.some(removed => key(removed) === key(term))) continue;
    if (validVocabularyTerms([...used, ...suggestions, term])) suggestions.push(term);
  }
  return ok({ scope: { ...source.scope }, catalogueHash: current.hash, expectedRevision: prior?.revision ?? "absent",
    manualTerms, selectedTerms: [...selectedTerms], suggestions });
}

/** Explicit public-only owner review. The persistence owner must compare-and-swap
 * expectedRevision atomically and freshly recheck source and actor at commit.
 * Syntax validation cannot establish that a manual term is publicly published. */
export function reviewClinicVocabulary(source: PublicVocabularyCatalogue, prior: ClinicVocabulary | undefined,
  input: Readonly<{ expectedRevision: string; catalogueHash: string; manualPublicTerms: readonly string[];
    selectedTerms: readonly string[] }>): Result<ClinicVocabulary, VocabularyFailure> {
  const proposal = proposeClinicVocabulary(source, prior);
  if (!proposal.ok) return proposal;
  if (!exact(input, "catalogueHash,expectedRevision,manualPublicTerms,selectedTerms")) return invalid();
  if (input.expectedRevision !== proposal.value.expectedRevision || input.catalogueHash !== proposal.value.catalogueHash) return stale();
  if (!validVocabularyTerms(input.manualPublicTerms) || !validVocabularyTerms(input.selectedTerms) ||
      !validVocabularyTerms([...input.manualPublicTerms, ...input.selectedTerms])) return invalid();
  const publicTerms = catalogue(source)!.terms;
  if (input.selectedTerms.some(term => !publicTerms.includes(term))) return invalid();
  const kept = [...input.manualPublicTerms, ...input.selectedTerms].map(key);
  const removedTerms = [...prior?.removedTerms ?? []];
  for (const term of [...prior?.manualTerms ?? [], ...prior?.selectedTerms ?? []]) {
    if (!kept.includes(key(term)) && !removedTerms.some(removed => key(removed) === key(term))) removedTerms.push(term);
  }
  // Explicit selection may restore a previously removed term; refresh alone cannot.
  const draft = { scope: { ...source.scope }, version: String(Number(prior?.version ?? "0") + 1), catalogueHash: proposal.value.catalogueHash,
    manualTerms: [...input.manualPublicTerms], selectedTerms: [...input.selectedTerms],
    removedTerms: removedTerms.filter(term => !kept.includes(key(term))) };
  const saved = { ...draft, revision: vocabularyRevision(draft) };
  return validClinicVocabulary(saved) ? ok(saved) : invalid();
}

/** Current complete source must still match at use, not merely at review time. */
export function currentVocabularyTerms(source: PublicVocabularyCatalogue, value: ClinicVocabulary): Result<readonly string[], VocabularyFailure> {
  const current = catalogue(source);
  if (!current || !validClinicVocabulary(value) || !sameScope(source.scope, value.scope)) return invalid();
  if (current.hash !== value.catalogueHash) return stale();
  if (value.selectedTerms.some(term => !current.terms.includes(term))) return invalid();
  return ok([...value.manualTerms, ...value.selectedTerms]);
}
