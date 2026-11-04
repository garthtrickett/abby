/** Shared browser/server limits for an explicitly public Nova-3 dictionary. */
export function validVocabularyTerms(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 50 && Array.from(value).every(term =>
    typeof term === "string" && !!term.trim() && term === term.trim() && term.length <= 80 &&
    !/[\u0000-\u001f\u007f,:;]/.test(term)) && new TextEncoder().encode(value.join(" ")).byteLength <= 1_000 &&
    new Set(value.map(term => term.toLowerCase())).size === value.length;
}
