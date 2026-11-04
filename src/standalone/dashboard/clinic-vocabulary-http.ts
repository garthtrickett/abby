import type { IncomingMessage } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { validVocabularyTerms } from "../../core/public-vocabulary-terms.ts";
import type { HostActor } from "../../reference/command-gateway.ts";
import { ClinicVocabularyReview } from "../clinic-vocabulary-review.ts";

type Config = Readonly<{
  request: IncomingMessage; actor: HostActor; review: ClinicVocabularyReview;
  resolveActor(): HostActor | null | Promise<HostActor | null>;
  readBody(): Promise<unknown>; reply(status: number, value: unknown): void;
}>;
/** Existing host/origin authentication runs before this scoped optional route.
 * The body cannot select an actor, clinic, file, provider or quality evidence. */
export async function clinicVocabularyHttp(config: Config): Promise<void> {
  const { request, review, actor, reply } = config;
  const fail = (status: number, kind: string) => reply(status, { ok: false, error: { kind } });
  const signal = AbortSignal.timeout(5_000);
  const authorized = async () => isDeepStrictEqual(await config.resolveActor(), actor);
  try {
    if (!(review instanceof ClinicVocabularyReview) || actor.role !== "clinicAdmin" || !await authorized()) return fail(403, "forbidden");
    if (new URL(request.url ?? "/", "http://localhost").searchParams.size) return fail(400, "invalidVocabulary");
    if (request.method === "GET") {
      const result = await review.propose(actor, signal);
      if (!await authorized()) return fail(403, "forbidden");
      return result.ok ? reply(200, result) : fail(503, "vocabularyUnavailable");
    }
    if (request.method !== "POST") return fail(404, "notFound");
    const value = await config.readBody();
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !==
        "catalogueHash,expectedBinding,expectedRevision,manualPublicConfirmed,manualPublicTerms,selectedTerms") return fail(400, "invalidVocabulary");
    const row = value as Record<string, unknown>;
    if (![row.catalogueHash, row.expectedBinding, row.expectedRevision].every(item => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)) ||
        !validVocabularyTerms(row.manualPublicTerms) || !validVocabularyTerms(row.selectedTerms) ||
        !validVocabularyTerms([...row.manualPublicTerms, ...row.selectedTerms]) || typeof row.manualPublicConfirmed !== "boolean" ||
        row.manualPublicTerms.length > 0 && !row.manualPublicConfirmed) return fail(400, "invalidVocabulary");
    if (!await authorized()) return fail(403, "forbidden");
    const result = await review.save(actor, { expectedBinding: row.expectedBinding as string,
      expectedRevision: row.expectedRevision as string, catalogueHash: row.catalogueHash as string,
      manualPublicTerms: row.manualPublicTerms, selectedTerms: row.selectedTerms }, signal, authorized);
    if (result.ok) return reply(200, { ok: true, value: { saved: true } });
    if (result.error.kind === "staleVocabulary") return fail(409, "staleVocabulary");
    if (result.error.kind === "reviewBusy") return fail(423, "reviewBusy");
    return result.error.kind === "invalidVocabulary" ? fail(400, "invalidVocabulary") : fail(503, "vocabularyUnavailable");
  } catch { return fail(503, "vocabularyUnavailable"); }
}
