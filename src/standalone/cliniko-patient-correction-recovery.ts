import { isDeepStrictEqual } from "node:util";
import { ClinikoRecallReader } from "../cliniko/recalls.ts";
import type { ClinikoReviewRecord } from "../cliniko/recalls.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { HostActor } from "../reference/command-gateway.ts";
import { PostgresClinikoContactRevision } from "../storage/postgres-cliniko-contact-revision.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { sameScope } from "./appointment-change-authority.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { validAdminAccount } from "./identity/magic-link.ts";

export interface CorrectionRecoveryAuthority {
  /** Live authenticated host session, never an actor/role supplied in the request body. */
  currentActor(signal: AbortSignal): Promise<HostActor | null>;
  /** Independent current clinic authorization, confirmed record investigation and
   * sender/provider quiescence. Native notes/recalled state alone cannot grant this. */
  permitsReviewedResolution(actor: HostActor, review: ClinikoReviewRecord, signal: AbortSignal): Promise<boolean>;
}
type Config = Readonly<{ scope: LocationScope; businessId: string; credentialFingerprint: string; timeZone: string; recallTypeId: string;
  reader: ClinikoRecallReader; contacts: PostgresClinikoContactRevision; directory: AdminDirectory; authority: CorrectionRecoveryAuthority;
  /** Independently provisioned current clinic recovery policy, not the interrupted caller's consent. */
  enabled(signal: AbortSignal): Promise<boolean> }>;
export type CorrectionRecoveryRequest = Readonly<{ correctionRef: string; recallRef: string; reviewAcknowledged: true }>;
type Failure = Readonly<{ kind: "correctionRecoveryUnavailable" }>;

/** Human recovery clears only its durable account fence. No patient PATCH, replay,
 * native recall mutation or claim that the interrupted caller's update succeeded. */
export class ClinikoPatientCorrectionRecovery {
  readonly #config: Config;
  constructor(config: Config) {
    const selection = config.reader.selection();
    if (!(config.reader instanceof ClinikoRecallReader) || !(config.contacts instanceof PostgresClinikoContactRevision) ||
        !config.contacts.matches(config.scope.tenantId, config.credentialFingerprint) || selection.credentialFingerprint !== config.credentialFingerprint ||
        selection.scope.tenantId !== config.scope.tenantId || selection.scope.clinicId !== config.scope.clinicId ||
        !/^[1-9][0-9]{0,18}$/.test(config.businessId) || !/^[1-9][0-9]{0,18}$/.test(config.recallTypeId) ||
        typeof config.directory?.findByRef !== "function" || typeof config.authority?.currentActor !== "function" ||
        typeof config.authority?.permitsReviewedResolution !== "function" || typeof config.enabled !== "function") throw new TypeError("invalid correction recovery configuration");
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
  }
  async #actor(signal: AbortSignal, expected?: HostActor): Promise<HostActor | undefined> {
    const c = this.#config;
    if (signal.aborted || await c.enabled(signal) !== true) return undefined;
    const actor = await c.authority.currentActor(signal);
    if (!actor || actor.role !== "clinicAdmin" || !sameScope(actor.scope, c.scope) || expected && !isDeepStrictEqual(actor, expected)) return undefined;
    const account = await c.directory.findByRef(actor.actorRef);
    return account.ok && account.value && validAdminAccount(account.value) && isDeepStrictEqual(account.value.actor, actor) && !signal.aborted
      ? structuredClone(actor) : undefined;
  }
  #matches(review: ClinikoReviewRecord, correctionRef: string): boolean {
    const r = review.envelope.request, c = this.#config;
    return review.recalled === true && r.operation.kind === "patientUpdate" && r.operation.correctionRef === correctionRef &&
      sameScope(r.scope, c.scope) && r.businessId === c.businessId && r.credentialFingerprint === c.credentialFingerprint && r.timeZone === c.timeZone;
  }
  async resolve(request: CorrectionRecoveryRequest, external?: AbortSignal, authenticatedActor?: HostActor): Promise<Result<Readonly<{ kind: "contactReviewResolved"; alreadyResolved: boolean }>, Failure>> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
    const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
    const denied = () => err({ kind: "correctionRecoveryUnavailable" as const });
    try {
      if (!request || Object.keys(request).sort().join(",") !== "correctionRef,recallRef,reviewAcknowledged" || request.reviewAcknowledged !== true ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.correctionRef)) return denied();
      request = structuredClone(request);
      const run = async () => {
        const c = this.#config, actor = await this.#actor(signal, authenticatedActor);
        if (!actor) return denied();
        const status = await c.contacts.status(request.correctionRef);
        if (!status.ok || !status.value || status.value.binding !== "reviewBound") return denied();
        const review = await c.reader.readReview(c.scope, request.recallRef, c.recallTypeId, signal);
        if (!review.ok || !this.#matches(review.value, request.correctionRef) ||
            await c.authority.permitsReviewedResolution(actor, structuredClone(review.value), signal) !== true || !await this.#actor(signal, actor)) return denied();
        const again = await c.reader.readReview(c.scope, request.recallRef, c.recallTypeId, signal);
        if (!again.ok || !isDeepStrictEqual(again.value, review.value) || !this.#matches(again.value, request.correctionRef) ||
            await c.authority.permitsReviewedResolution(actor, structuredClone(again.value), signal) !== true || !await this.#actor(signal, actor)) return denied();
        if (status.value.status === "completed") return status.value.completionMethod === "staffReviewed"
          ? ok({ kind: "contactReviewResolved" as const, alreadyResolved: true }) : denied();
        if (signal.aborted) return denied();
        const completed = await c.contacts.completeReviewed(request.correctionRef, actor.actorRef);
        return completed.ok && !signal.aborted ? ok({ kind: "contactReviewResolved" as const, alreadyResolved: false }) : denied();
      };
      return await awaitUntilAbort(run(), signal) ?? denied();
    } catch { return denied(); } finally { clearTimeout(timer); controller.abort(); }
  }
}
