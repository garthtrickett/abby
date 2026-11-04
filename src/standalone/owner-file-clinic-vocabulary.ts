import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { currentVocabularyTerms, proposeClinicVocabulary, validClinicVocabulary } from "../core/clinic-vocabulary.ts";
import type { ClinicVocabulary, PublicVocabularyCatalogue } from "../core/clinic-vocabulary.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import type { ReviewedVocabularyBinding } from "../voice/reviewed-deepgram-transcription.ts";

export type ClinicVocabularyApproval = ClinicApproval & Readonly<{ vocabulary: ClinicVocabulary }>;
type Failure = Readonly<{ kind: "unavailable" }>;
export interface PublicVocabularyCatalogueReader {
  /** Exact current complete inventory plus separately approved public field refs.
   * Never obtain this input from caller audio, patient records or model output. */
  current(scope: LocationScope, signal: AbortSignal): Promise<Result<PublicVocabularyCatalogue, Failure>>;
}
export type ClinicVocabularyConfig = Readonly<{ path: string; scope: LocationScope; directory: AdminDirectory;
  catalogue: PublicVocabularyCatalogueReader; clock?: () => string }>;
type Config = ClinicVocabularyConfig;
function decode(value: unknown, scope: LocationScope): ClinicVocabularyApproval | undefined {
  if (!decodeClinicApproval(value, scope, [...clinicApprovalKeys, "vocabulary"])) return undefined;
  const row = value as ClinicVocabularyApproval;
  return validClinicVocabulary(row.vocabulary) && row.vocabulary.scope.tenantId === scope.tenantId &&
    row.vocabulary.scope.clinicId === scope.clinicId && row.vocabulary.scope.locationId === scope.locationId ? row : undefined;
}

/** Optional owner-provisioned public-only configuration. Existing approval-file
 * ownership, exact bytes, current membership and expiry checks stay authoritative.
 * This reader grants no editor, recording permission or speech-quality evidence. */
export class OwnerFileClinicVocabulary implements ReviewedVocabularyBinding {
  readonly version: string;
  readonly scope: LocationScope;
  readonly #config: Config;
  readonly #source: OwnerFileClinicApproval<ClinicVocabularyApproval>;
  private constructor(config: Config, source: OwnerFileClinicApproval<ClinicVocabularyApproval>) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
    this.scope = this.#config.scope;
    this.#source = source;
    this.version = createHash("sha256").update(source.bindingFingerprint()).digest("hex");
  }
  static async capture(config: Config): Promise<Result<OwnerFileClinicVocabulary, Failure>> {
    const captured = await OwnerFileClinicVocabulary.captureForReview(config);
    if (!captured.ok) return captured;
    const found = await captured.value.current(AbortSignal.timeout(5_000));
    return found.ok ? captured : found;
  }
  /** Refresh can review a changed catalogue; speech capture above still refuses
   * that changed source until a new owner review has been saved. */
  static async captureForReview(config: Config): Promise<Result<OwnerFileClinicVocabulary, Failure>> {
    try {
      const source = await awaitUntilAbort(OwnerFileClinicApproval.capture({ ...config, decode }), AbortSignal.timeout(5_000));
      if (!source?.ok) return err({ kind: "unavailable" });
      const bound = new OwnerFileClinicVocabulary(config, source.value);
      const found = await bound.reviewState(AbortSignal.timeout(5_000));
      return found.ok ? ok(bound) : found;
    } catch { return err({ kind: "unavailable" }); }
  }
  async current(incoming: AbortSignal): Promise<Result<readonly string[], Failure>> {
    const found = await this.reviewState(incoming);
    if (!found.ok) return found;
    const terms = currentVocabularyTerms(found.value.catalogue, found.value.approval.vocabulary);
    return terms.ok ? terms : err({ kind: "unavailable" });
  }
  /** Backend review snapshot; this is not a public route or caller capability. */
  async reviewState(incoming: AbortSignal): Promise<Result<Readonly<{
    approval: ClinicVocabularyApproval; catalogue: PublicVocabularyCatalogue; binding: string;
  }>, Failure>> {
    const signal = AbortSignal.any([incoming, AbortSignal.timeout(5_000)]);
    try {
      const row = await awaitUntilAbort(this.#source.current(this.#config.scope), signal);
      if (!row?.ok || !row.value) return err({ kind: "unavailable" });
      const catalogue = await awaitUntilAbort(this.#config.catalogue.current(this.#config.scope, signal), signal);
      if (!catalogue?.ok) return err({ kind: "unavailable" });
      if (!proposeClinicVocabulary(catalogue.value, row.value.vocabulary).ok) return err({ kind: "unavailable" });
      const again = await awaitUntilAbort(this.#source.current(this.#config.scope), signal);
      return again?.ok && again.value && !signal.aborted
        ? ok({ approval: structuredClone(row.value), catalogue: structuredClone(catalogue.value), binding: this.version })
        : err({ kind: "unavailable" });
    } catch { return err({ kind: "unavailable" }); }
  }
}
