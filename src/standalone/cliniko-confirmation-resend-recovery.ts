import { PostgresConfirmationResendImportHistory } from "../storage/postgres-confirmation-resend-import-history.ts";
import type { ConfirmationResendImportBinding } from "../storage/postgres-confirmation-resend-import-history.ts";
import { isDeepStrictEqual } from "node:util";
import { ClinikoRecallReader } from "../cliniko/recalls.ts";
import type { ClinikoReviewRecord } from "../cliniko/recalls.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { HostActor } from "../reference/command-gateway.ts";
import { PostgresConfirmationResendJournal } from "../storage/postgres-confirmation-resend-journal.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { confirmationResendRef } from "./confirmation-resend-journal.ts";
import { OwnerFileConfirmationResendPolicy } from "./owner-file-confirmation-resend-policy.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { validAdminAccount } from "./identity/magic-link.ts";

export interface ConfirmationResendRecoveryAuthority {
  /** Current authenticated session supplied by the clinic host, never request JSON. */
  currentActor(signal: AbortSignal): Promise<HostActor | null>;
  /** Independent current permission to inspect this native review and its receipt. */
  permitsReceiptInspection(actor: HostActor, review: ClinikoReviewRecord, signal: AbortSignal): Promise<boolean>;
}
type Config = Readonly<{ scope: LocationScope; businessId: string; credentialFingerprint: string; timeZone: string; recallTypeId: string;
  reader: ClinikoRecallReader; policy: OwnerFileConfirmationResendPolicy; directory: AdminDirectory;
  /** Historical bindings are read under current staff permission; they grant no send authority. */
  journalFor(ownerBinding: string): PostgresConfirmationResendJournal;
  authority: ConfirmationResendRecoveryAuthority;
  /** Trusted target composition only; the HTTP request remains two opaque references. */
  importHistory?: PostgresConfirmationResendImportHistory;
  readerForOrigin?: (scope: LocationScope) => ClinikoRecallReader;
}>;
export type ConfirmationResendRecoveryRequest = Readonly<{ requestRef: string; recallRef: string }>;
export type ConfirmationResendRecoveryStatus = Readonly<{ kind: "acceptedByMailService" | "definitiveUnsent" | "unknown" | "notRecorded";
  reviewAcknowledged: boolean; message: string }>;
type Failure = Readonly<{ kind: "confirmationResendRecoveryUnavailable" }>;
const messages = {
  acceptedByMailService: "The mail service accepted this appointment-details email. Inbox delivery has not been verified.",
  definitiveUnsent: "The recorded submission was definitively unsent. Recovery has not sent or retried an email.",
  unknown: "The submission outcome is unknown and needs investigation. Recovery has not sent or retried an email.",
  notRecorded: "No durable submission record was found. This does not prove that a live sender has stopped. Recovery has not sent or retried an email.",
} as const;

/** Cold staff recovery is a receipt observation. No native mutation, journal
 * completion, send port or reconstructed caller confirmation exists here. */
export class ClinikoConfirmationResendRecovery {
  readonly #config: Config;
  constructor(config: Config) {
    const selection = config.reader.selection();
    if (!(config.reader instanceof ClinikoRecallReader) || !(config.policy instanceof OwnerFileConfirmationResendPolicy) ||
        selection.credentialFingerprint !== config.credentialFingerprint || selection.scope.tenantId !== config.scope.tenantId ||
        selection.scope.clinicId !== config.scope.clinicId || typeof config.journalFor !== "function" ||
        typeof config.directory?.findByRef !== "function" || typeof config.authority?.currentActor !== "function" ||
        typeof config.authority?.permitsReceiptInspection !== "function" ||
        (config.importHistory !== undefined || config.readerForOrigin !== undefined) &&
          (!(config.importHistory instanceof PostgresConfirmationResendImportHistory) || !config.importHistory.matches(config.scope) ||
            typeof config.readerForOrigin !== "function")) throw new TypeError("invalid resend recovery configuration");
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
  }
  async #actor(signal: AbortSignal, expected?: HostActor): Promise<HostActor | undefined> {
    const c = this.#config;
    if (signal.aborted) return undefined;
    const policy = await c.policy.current(c.scope);
    if (!policy.ok || policy.value.businessId !== c.businessId || policy.value.credentialFingerprint !== c.credentialFingerprint ||
        policy.value.timeZone !== c.timeZone || policy.value.recallTypeId !== c.recallTypeId) return undefined;
    const actor = await c.authority.currentActor(signal);
    if (!actor || actor.role !== "clinicAdmin" || !sameScope(actor.scope, c.scope) || expected && !isDeepStrictEqual(actor, expected)) return undefined;
    const account = await c.directory.findByRef(actor.actorRef);
    return account.ok && account.value && validAdminAccount(account.value) && isDeepStrictEqual(account.value.actor, actor) && !signal.aborted
      ? structuredClone(actor) : undefined;
  }
  #matches(review: ClinikoReviewRecord, ref: string, origin: LocationScope, imported?: ConfirmationResendImportBinding | null): boolean {
    const r = review.envelope.request, c = this.#config;
    return r.operation.kind === "confirmationResend" && r.operation.resendRef === ref && sameScope(r.scope, origin) &&
      (!imported || r.termsVersion === imported.ownerBinding) &&
      r.businessId === c.businessId && r.credentialFingerprint === c.credentialFingerprint && r.timeZone === c.timeZone && /^[a-f0-9]{64}$/.test(r.termsVersion);
  }
  async inspect(request: ConfirmationResendRecoveryRequest, external?: AbortSignal, authenticatedActor?: HostActor): Promise<Result<ConfirmationResendRecoveryStatus, Failure>> {
    const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(external ? [external] : [])]);
    const denied = () => err({ kind: "confirmationResendRecoveryUnavailable" as const });
    try {
      if (!request || Object.keys(request).sort().join(",") !== "recallRef,requestRef" || !confirmationResendRef(request.requestRef) ||
          typeof request.recallRef !== "string" || !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(request.recallRef)) return denied();
      request = structuredClone(request);
      const result = await awaitUntilAbort((async () => {
        const c = this.#config, actor = await this.#actor(signal, authenticatedActor);
        if (!actor) return denied();
        const history = c.importHistory ? await c.importHistory.lookup(request.requestRef, signal) : ok(null);
        if (!history.ok) return denied();
        const imported = history.value, origin = imported?.sourceScope ?? c.scope;
        const reader = imported ? c.readerForOrigin!(structuredClone(origin)) : c.reader;
        if (!(reader instanceof ClinikoRecallReader)) return denied();
        const selection = reader.selection();
        if (selection.credentialFingerprint !== c.credentialFingerprint || selection.scope.tenantId !== origin.tenantId ||
            selection.scope.clinicId !== origin.clinicId || !await this.#actor(signal, actor)) return denied();
        const review = await reader.readReview(origin, request.recallRef, c.recallTypeId, signal);
        if (!review.ok || !this.#matches(review.value, request.requestRef, origin, imported) ||
            await c.authority.permitsReceiptInspection(actor, structuredClone(review.value), signal) !== true || !await this.#actor(signal, actor)) return denied();
        const binding = review.value.envelope.request.termsVersion, journal = c.journalFor(binding);
        if (!(journal instanceof PostgresConfirmationResendJournal) || !journal.matches(c.scope, binding)) return denied();
        const again = await reader.readReview(origin, request.recallRef, c.recallTypeId, signal);
        if (!again.ok || !isDeepStrictEqual(again.value, review.value) || !this.#matches(again.value, request.requestRef, origin, imported) ||
            await c.authority.permitsReceiptInspection(actor, structuredClone(again.value), signal) !== true || !await this.#actor(signal, actor)) return denied();
        const receipt = await journal.read(request.requestRef);
        const latest = c.importHistory ? await c.importHistory.lookup(request.requestRef, signal) : ok(null);
        if (!latest.ok || !isDeepStrictEqual(latest.value, imported) || !receipt.ok || !await this.#actor(signal, actor) || signal.aborted) return denied();
        const kind = receipt.value === null ? "notRecorded" : receipt.value.kind === "accepted" && receipt.value.messageRef === request.requestRef
          ? "acceptedByMailService" : receipt.value.kind === "definitiveUnsent" ? "definitiveUnsent" : "unknown";
        return ok<ConfirmationResendRecoveryStatus>({ kind, reviewAcknowledged: again.value.recalled, message: messages[kind] });
      })(), signal);
      return result && !signal.aborted ? result : denied();
    } catch { return denied(); }
  }
}
