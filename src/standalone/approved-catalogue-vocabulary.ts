import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { validVoiceRef } from "../core/voice-profile.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import type { OwnerFileServiceCatalogue } from "./owner-file-service-catalogue.ts";
import type { PublicVocabularyCatalogueReader } from "./owner-file-clinic-vocabulary.ts";
import type { PublicVocabularyItem } from "../core/clinic-vocabulary.ts";

export type CataloguePublicationApproval = ClinicApproval & Readonly<{
  catalogueBinding: string; publicRefs: readonly string[];
}>;
type Config = Readonly<{ path: string; scope: LocationScope; directory: AdminDirectory; clock?: () => string;
  captureCatalogue(scope: LocationScope, signal: AbortSignal): Promise<Result<OwnerFileServiceCatalogue, Readonly<{ kind: "unavailable" }>>>;
}>;
function decode(value: unknown, scope: LocationScope): CataloguePublicationApproval | undefined {
  if (!decodeClinicApproval(value, scope, [...clinicApprovalKeys, "catalogueBinding", "publicRefs"])) return undefined;
  const row = value as CataloguePublicationApproval;
  return /^[a-f0-9]{64}$/.test(row.catalogueBinding) && Array.isArray(row.publicRefs) && row.publicRefs.length <= 128 &&
    Array.from(row.publicRefs).every(validVoiceRef) && new Set(row.publicRefs).size === row.publicRefs.length ? row : undefined;
}

/** The complete currently approved booking inventory at one location. This does
 * not claim to inventory every native Cliniko service or every clinic location.
 * Booking approval never implies publication: a separate current owner file
 * whitelists exact public fields and pins the complete catalogue binding. */
export class ApprovedCatalogueVocabulary implements PublicVocabularyCatalogueReader {
  readonly #config: Config;
  constructor(config: Config) { this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) }); }
  async current(scope: LocationScope, signal: AbortSignal) {
    const unavailable = () => err({ kind: "unavailable" as const });
    try {
      const config = this.#config;
      if (scope.tenantId !== config.scope.tenantId || scope.clinicId !== config.scope.clinicId ||
          scope.locationId !== config.scope.locationId || signal.aborted) return unavailable();
      const publication = await awaitUntilAbort(OwnerFileClinicApproval.capture({ ...config, decode }), signal);
      if (!publication?.ok) return unavailable();
      const approved = await awaitUntilAbort(publication.value.current(scope), signal);
      if (!approved?.ok || !approved.value) return unavailable();
      const catalogue = await awaitUntilAbort(config.captureCatalogue(scope, signal), signal);
      if (!catalogue?.ok || catalogue.value.bindingFingerprint() !== approved.value.catalogueBinding) return unavailable();
      const found = await awaitUntilAbort(catalogue.value.current(scope), signal);
      if (!found?.ok) return unavailable();
      const items: PublicVocabularyItem[] = [{ ref: "location:" + scope.locationId, kind: "location", publicText: found.value.locationName }];
      for (const service of found.value.services) {
        items.push({ ref: "service:" + service.serviceRef, kind: "service", publicText: service.name });
        for (const practitioner of service.practitioners) {
          const ref = "practitioner:" + practitioner.practitionerId;
          if (!items.some(item => item.ref === ref)) items.push({ ref, kind: "practitioner", publicText: practitioner.name });
        }
      }
      if (approved.value.publicRefs.some(ref => !items.some(item => item.ref === ref))) return unavailable();
      const stillApproved = await awaitUntilAbort(publication.value.current(scope), signal);
      const stillCurrent = await awaitUntilAbort(catalogue.value.current(scope), signal);
      if (!stillApproved?.ok || !stillApproved.value || !stillCurrent?.ok || signal.aborted) return unavailable();
      const version = createHash("sha256").update(JSON.stringify([
        catalogue.value.bindingFingerprint(), publication.value.bindingFingerprint()])).digest("hex");
      return ok({ scope: { ...scope }, version, complete: true as const, items,
        approvedPublicRefs: [...approved.value.publicRefs] });
    } catch { return unavailable(); }
  }
}
