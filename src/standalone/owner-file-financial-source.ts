import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { financialRecordOwnerBinding } from "../cliniko/financial-record-retention.ts";
import type { FinancialRecordRetentionConfig } from "../cliniko/financial-record-retention.ts";
import { financialSelection } from "../cliniko/internal/financial-record-context.ts";
import type { ClinikoFinancialReviewSelection } from "../cliniko/financial-review-read.ts";
import { clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval, approvalInstant } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval, ClinicApprovalFailure } from "./owner-file-clinic-approval.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";

export type FinancialContentPolicy = Readonly<{ version: string; digest: string }>;
export type FinancialSourceSelection = ClinikoFinancialReviewSelection & Readonly<{
  producer: Readonly<{ keyRef: string; publicKeyFingerprint: string }>;
  contentPolicy: FinancialContentPolicy;
}>;
type Source = Omit<FinancialSourceSelection, "scope">;
/** Non-patient source definition only: no patient, payable, recipient, grant,
 * manual-paid/waiver decision or producer/restore admission belongs here. */
export type FinancialSourceApproval = ClinicApproval & Readonly<{ source: Source }>;
type Config = Readonly<{ path: string; scope: LocationScope; directory: AdminDirectory; clock?: () => string; deadlineMs?: number }>;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string) => Object.keys(v).sort().join(",") === expected;
const ref = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function source(value: unknown): Source | undefined {
  if (!record(value) || !keys(value, "businessId,contentPolicy,credentialFingerprint,producer,recallTypeId,stripe") ||
      !validClinikoId(value.businessId) || !validClinikoId(value.recallTypeId) || !digest(value.credentialFingerprint) ||
      !record(value.stripe) || !keys(value.stripe, "accountRef,livemode") || typeof value.stripe.accountRef !== "string" ||
      !/^acct_[A-Za-z0-9]{1,128}$/.test(value.stripe.accountRef) || typeof value.stripe.livemode !== "boolean" ||
      !record(value.producer) || !keys(value.producer, "keyRef,publicKeyFingerprint") || !ref(value.producer.keyRef) || !digest(value.producer.publicKeyFingerprint) ||
      !record(value.contentPolicy) || !keys(value.contentPolicy, "digest,version") || !ref(value.contentPolicy.version) || !digest(value.contentPolicy.digest)) return undefined;
  return Object.freeze({ businessId: value.businessId, credentialFingerprint: value.credentialFingerprint, recallTypeId: value.recallTypeId,
    stripe: Object.freeze({ accountRef: value.stripe.accountRef, livemode: value.stripe.livemode }),
    producer: Object.freeze({ keyRef: value.producer.keyRef, publicKeyFingerprint: value.producer.publicKeyFingerprint }),
    contentPolicy: Object.freeze({ version: value.contentPolicy.version, digest: value.contentPolicy.digest }) });
}
function decode(value: unknown, scope: LocationScope): FinancialSourceApproval | undefined {
  const common = decodeClinicApproval(value, scope, [...clinicApprovalKeys, "source"]);
  if (!common || !record(value)) return undefined;
  const selected = source(value.source);
  return selected ? { ...common, source: selected } : undefined;
}
/** Derive approval context from the actual selected native/Stripe account and
 * producer public key, without returning credentials or any patient context. */
export function financialSourceSelection(config: FinancialRecordRetentionConfig, contentPolicy: FinancialContentPolicy): Result<FinancialSourceSelection, ClinicApprovalFailure> {
  try {
    if (!financialRecordOwnerBinding(config).ok) return err({ kind: "unavailable" });
    const { scope, ...selected } = financialSelection(config);
    const bound = source({ ...selected, producer: { keyRef: config.producer.keyRef,
      publicKeyFingerprint: createHash("sha256").update(config.producer.publicKey.export({ type: "spki", format: "der" })).digest("hex") }, contentPolicy });
    return bound ? ok(Object.freeze({ scope, ...bound })) : err({ kind: "unavailable" });
  } catch { return err({ kind: "unavailable" }); }
}
async function bounded<T>(signal: AbortSignal, ms: number, task: () => Promise<T>): Promise<T | undefined> {
  if (!(signal instanceof AbortSignal) || signal.aborted) return undefined;
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), ms), combined = AbortSignal.any([signal, deadline.signal]), began = performance.now();
  try { const found = await awaitUntilAbort(Promise.resolve().then(task), combined); return combined.aborted || performance.now() - began > ms ? undefined : found; }
  catch { return undefined; } finally { clearTimeout(timer); deadline.abort(); }
}

/** Source approval is distinct from every current financial/patient/effect grant.
 * Construction starts no consumer, listener, native read, payment or mail. */
export class OwnerFileFinancialSource {
  readonly #source: OwnerFileClinicApproval<FinancialSourceApproval>;
  readonly #scope: LocationScope;
  readonly #clock: () => string;
  readonly #deadlineMs: number;
  readonly #capturedAt: number;
  private constructor(source: OwnerFileClinicApproval<FinancialSourceApproval>, config: Config, clock: () => string, capturedAt: number) {
    this.#source = source; this.#scope = Object.freeze({ ...config.scope }); this.#clock = clock; this.#deadlineMs = config.deadlineMs ?? 15_000; this.#capturedAt = capturedAt;
  }
  static async capture(config: Config, signal: AbortSignal): Promise<Result<OwnerFileFinancialSource, ClinicApprovalFailure>> {
    try {
      const ms = config.deadlineMs ?? 15_000;
      if (!Number.isSafeInteger(ms) || ms < 1 || ms > 15_000 || typeof config.directory?.findByRef !== "function" ||
          typeof config.directory.findByEmail !== "function" || config.clock !== undefined && typeof config.clock !== "function") return err({ kind: "unavailable" });
      const clock = config.clock?.bind(config) ?? (() => new Date().toISOString()), began = approvalInstant(clock()); if (began === undefined) return err({ kind: "unavailable" });
      const directory = Object.freeze({ findByRef: config.directory.findByRef.bind(config.directory), findByEmail: config.directory.findByEmail.bind(config.directory) });
      const captured = Object.freeze({ path: config.path, scope: Object.freeze({ ...config.scope }), directory, clock, deadlineMs: ms });
      const found = await bounded(signal, ms, () => OwnerFileClinicApproval.capture({ ...captured, decode }));
      const end = approvalInstant(clock());
      return found?.ok && end !== undefined && end >= began && !signal.aborted
        ? ok(new OwnerFileFinancialSource(found.value, captured, clock, began)) : err({ kind: "unavailable" });
    } catch { return err({ kind: "unavailable" }); }
  }
  async currentFor(selection: FinancialSourceSelection, signal: AbortSignal): Promise<Result<boolean, ClinicApprovalFailure>> {
    try {
      if (!record(selection) || !keys(selection, "businessId,contentPolicy,credentialFingerprint,producer,recallTypeId,scope,stripe") ||
          !record(selection.scope) || !keys(selection.scope, "clinicId,locationId,tenantId") || !sameScope(selection.scope as LocationScope, this.#scope)) return ok(false);
      const { scope: _, ...raw } = selection, selected = source(raw); if (!selected) return ok(false);
      const began = approvalInstant(this.#clock()); if (began === undefined || began < this.#capturedAt) return err({ kind: "unavailable" });
      const found = await bounded(signal, this.#deadlineMs, () => this.#source.current(this.#scope));
      const end = approvalInstant(this.#clock());
      if (!found || end === undefined || end < began || signal.aborted) return err({ kind: "unavailable" });
      if (!found.ok) return found;
      return ok(!!found.value && end >= Date.parse(found.value.effectiveFrom) && end < Date.parse(found.value.effectiveUntil) &&
        JSON.stringify(source(found.value.source)) === JSON.stringify(selected));
    } catch { return err({ kind: "unavailable" }); }
  }
}
