import { createHash, KeyObject } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { verifyFinancialWaiverDecision } from "../cliniko/financial-waiver-decision.ts";
import type { FinancialWaiverExpected, FinancialWaiverIssuerKey, FinancialWaiverDecision } from "../cliniko/financial-waiver-decision.ts";
import type { FinancialRecordRetentionConfig } from "../cliniko/financial-record-retention.ts";
import { financialSelection, financialRecordInstant } from "../cliniko/internal/financial-record-context.ts";
import type { ClinikoFinancialReviewConfig } from "../cliniko/internal/financial-record-context.ts";
import { OwnerFileFinancialSource, financialSourceSelection } from "./owner-file-financial-source.ts";
import type { FinancialSourceSelection } from "./owner-file-financial-source.ts";
import { sameScope } from "./appointment-change-authority.ts";

/** Fixed purpose separates this approval from booking-producer trust and the
 * ordinary financial record schema. The approved file remains non-patient. */
export const financialWaiverContentPolicy = Object.freeze({ version: "financial-waiver-v1",
  digest: createHash("sha256").update("abby.financial-waiver.v1:explicit-positive-signed-decision:exact-intent-and-target:no-payment-or-clinical-grant").digest("hex") });
type Failure = Readonly<{ kind: "unavailable" }>;

/** An explicitly supplied issuer key needs its own current clinic source
 * approval. The native config's booking producer key is never adopted here. */
export class ApprovedFinancialWaiverIssuer {
  readonly #definition: OwnerFileFinancialSource;
  readonly #selection: FinancialSourceSelection;
  readonly #issuer: FinancialWaiverIssuerKey;
  readonly #clock: () => string;
  private constructor(definition: OwnerFileFinancialSource, selection: FinancialSourceSelection, issuer: FinancialWaiverIssuerKey, clock: () => string) {
    this.#definition = definition; this.#selection = selection; this.#issuer = Object.freeze({ keyRef: issuer.keyRef, publicKey: issuer.publicKey });
    this.#clock = clock;
  }
  static create(config: FinancialRecordRetentionConfig, issuer: FinancialWaiverIssuerKey,
    definition: OwnerFileFinancialSource): Result<ApprovedFinancialWaiverIssuer, Failure> {
    try {
      if (!(definition instanceof OwnerFileFinancialSource) || !(issuer?.publicKey instanceof KeyObject) ||
          issuer.publicKey.type !== "public" || issuer.publicKey.asymmetricKeyType !== "ed25519") return err({ kind: "unavailable" });
      const selected = financialSourceSelection({ ...config, producer: issuer }, financialWaiverContentPolicy);
      return selected.ok ? ok(new ApprovedFinancialWaiverIssuer(definition, selected.value, issuer,
        config.clock?.bind(config) ?? (() => new Date().toISOString()))) : err({ kind: "unavailable" });
    } catch { return err({ kind: "unavailable" }); }
  }
  matches(config: ClinikoFinancialReviewConfig): boolean {
    try {
      const actual = financialSelection(config), wanted = this.#selection;
      return sameScope(actual.scope, wanted.scope) && actual.businessId === wanted.businessId && actual.recallTypeId === wanted.recallTypeId &&
        actual.credentialFingerprint === wanted.credentialFingerprint && actual.stripe.accountRef === wanted.stripe.accountRef && actual.stripe.livemode === wanted.stripe.livemode;
    } catch { return false; }
  }
  async current(signal: AbortSignal): Promise<boolean> {
    try { const found = await this.#definition.currentFor(this.#selection, signal); return found.ok && found.value === true && !signal.aborted; }
    catch { return false; }
  }
  /** Native readers must additionally establish exact record/patient binding
   * and current read permission. This is no collection or financial effect. */
  async verifyCurrent(notes: unknown, expected: FinancialWaiverExpected,
    signal: AbortSignal): Promise<Result<FinancialWaiverDecision, Failure>> {
    try {
      const captured = structuredClone(expected), began = financialRecordInstant(this.#clock());
      const intent = captured.intent, source = this.#selection;
      if (!began || !sameScope(intent.scope, source.scope) || intent.businessId !== source.businessId ||
          intent.credentialFingerprint !== source.credentialFingerprint || intent.stripe.accountRef !== source.stripe.accountRef || intent.stripe.livemode !== source.stripe.livemode) return err({ kind: "unavailable" });
      if (!await this.current(signal)) return err({ kind: "unavailable" });
      const found = verifyFinancialWaiverDecision(notes, captured, this.#issuer, began);
      if (!found.ok || !await this.current(signal)) return err({ kind: "unavailable" });
      const end = financialRecordInstant(this.#clock());
      return end && end >= began && verifyFinancialWaiverDecision(notes, captured, this.#issuer, end).ok ? found : err({ kind: "unavailable" });
    } catch { return err({ kind: "unavailable" }); }
  }
}
