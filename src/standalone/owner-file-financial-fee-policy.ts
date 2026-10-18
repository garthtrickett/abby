import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import type { FinancialBookingSelection } from "./cliniko-financial-booking-preparation.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";
import { approvalInstant, approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval, ClinicApprovalFailure } from "./owner-file-clinic-approval.ts";

/** Public service terms only. An explicit no-deposit policy is not a patient fee
 * waiver, evidence of received money or a grant for clinical/financial effects. */
export type FinancialFeeTerms = Readonly<{ kind: "notRequired"; version: string }> | Readonly<{
  kind: "required"; amount: number; currency: "aud" | "gbp" | "nzd" | "cad" | "usd" | "eur";
  policyVersion: string; termsVersion: string; approvedTerms: string; paymentWindowMinutes: number;
}>;
export type FinancialFeeApproval = ClinicApproval & Readonly<{
  selection: Readonly<{ policyVersion: string; businessId: string; credentialFingerprint: string;
    practitionerId: string; appointmentTypeId: string; timeZone: string; bookingKind: "book" | "classBook"; passUse: "none" | "selected" }>;
  terms: FinancialFeeTerms;
}>;
type Config = Readonly<{ path: string; scope: LocationScope; directory: AdminDirectory; clock?: () => string; deadlineMs?: number }>;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(",") === keys;
function decode(value: unknown, scope: LocationScope): FinancialFeeApproval | undefined {
  const common = decodeClinicApproval(value, scope, [...clinicApprovalKeys, "selection", "terms"]);
  if (!common || !object(value) || !object(value.selection) || !object(value.terms)) return undefined;
  const s = value.selection, t = value.terms;
  if (!exact(s, "appointmentTypeId,bookingKind,businessId,credentialFingerprint,passUse,policyVersion,practitionerId,timeZone") ||
      !approvalRef(s.policyVersion) || ![s.businessId, s.practitionerId, s.appointmentTypeId].every(validClinikoId) ||
      typeof s.credentialFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(s.credentialFingerprint) ||
      typeof s.timeZone !== "string" || s.timeZone.length > 128 || !["book", "classBook"].includes(String(s.bookingKind)) ||
      !["none", "selected"].includes(String(s.passUse)) || s.bookingKind === "book" && s.passUse !== "none") return undefined;
  try { new Intl.DateTimeFormat("en", { timeZone: s.timeZone }); } catch { return undefined; }
  if (t.kind === "notRequired") {
    if (!exact(t, "kind,version") || !approvalRef(t.version)) return undefined;
  } else if (t.kind !== "required" || !exact(t, "amount,approvedTerms,currency,kind,paymentWindowMinutes,policyVersion,termsVersion") ||
      !Number.isSafeInteger(t.amount) || Number(t.amount) < 1 || Number(t.amount) > 99_999_999 ||
      !["aud", "gbp", "nzd", "cad", "usd", "eur"].includes(String(t.currency)) || !approvalRef(t.policyVersion) || !approvalRef(t.termsVersion) ||
      typeof t.approvedTerms !== "string" || !t.approvedTerms.trim() || t.approvedTerms.length > 350 || /[\u0000-\u001f\u007f]/.test(t.approvedTerms) ||
      !Number.isSafeInteger(t.paymentWindowMinutes) || Number(t.paymentWindowMinutes) < 1 || Number(t.paymentWindowMinutes) > 10_080) return undefined;
  return value as unknown as FinancialFeeApproval;
}
async function bounded<T>(signal: AbortSignal, ms: number, task: () => Promise<T>): Promise<T | undefined> {
  if (!(signal instanceof AbortSignal) || signal.aborted) return undefined;
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), ms), began = performance.now();
  const combined = AbortSignal.any([signal, deadline.signal]);
  try { const result = await awaitUntilAbort(Promise.resolve().then(task), combined); return combined.aborted || performance.now() - began > ms ? undefined : result; }
  catch { return undefined; } finally { clearTimeout(timer); deadline.abort(); }
}
/** Explicit owner-file source, inactive until composed by the deploying host.
 * Stores no patient/appointment, recipient, quote, paid status or effect ID.
 * Unknown or changed approval never becomes an implicit no-deposit decision. */
export class OwnerFileFinancialFeePolicy {
  readonly #source: OwnerFileClinicApproval<FinancialFeeApproval>;
  readonly #scope: LocationScope;
  readonly #clock: () => string;
  readonly #deadlineMs: number;
  readonly #capturedAt: number;
  private constructor(source: OwnerFileClinicApproval<FinancialFeeApproval>, config: Config, clock: () => string, capturedAt: number) {
    this.#source = source; this.#scope = Object.freeze({ ...config.scope }); this.#clock = clock;
    this.#deadlineMs = config.deadlineMs ?? 15_000; this.#capturedAt = capturedAt;
  }
  static async capture(config: Config, signal: AbortSignal): Promise<Result<OwnerFileFinancialFeePolicy, ClinicApprovalFailure>> {
    try {
      const ms = config.deadlineMs ?? 15_000;
      if (!Number.isSafeInteger(ms) || ms < 1 || ms > 15_000 || typeof config.directory?.findByRef !== "function" ||
          typeof config.directory.findByEmail !== "function" || config.clock !== undefined && typeof config.clock !== "function") return err({ kind: "unavailable" });
      const clock = config.clock?.bind(config) ?? (() => new Date().toISOString()), began = approvalInstant(clock());
      if (began === undefined) return err({ kind: "unavailable" });
      const directory = Object.freeze({ findByRef: config.directory.findByRef.bind(config.directory), findByEmail: config.directory.findByEmail.bind(config.directory) });
      const captured = Object.freeze({ path: config.path, scope: Object.freeze({ ...config.scope }), directory, clock, deadlineMs: ms });
      const found = await bounded(signal, ms, () => OwnerFileClinicApproval.capture({ ...captured, decode }));
      const end = approvalInstant(clock());
      return found?.ok && end !== undefined && end >= began && !signal.aborted
        ? ok(new OwnerFileFinancialFeePolicy(found.value, captured, clock, began)) : err({ kind: "unavailable" });
    } catch { return err({ kind: "unavailable" }); }
  }
  bindingFingerprint(): string { return this.#source.bindingFingerprint(); }
  async currentFor(selection: FinancialBookingSelection, signal: AbortSignal): Promise<Result<FinancialFeeApproval | undefined, ClinicApprovalFailure>> {
    try {
      // Snapshot only public selection before any held membership read. Private
      // caller/patient/offer/verification context is never retained by this owner.
      const bound = { scope: { ...selection.scope }, policyVersion: selection.policyVersion, businessId: selection.businessId,
        credentialFingerprint: selection.credentialFingerprint, practitionerId: selection.practitionerId, appointmentTypeId: selection.appointmentTypeId,
        timeZone: selection.timeZone, bookingKind: selection.bookingKind, passUse: selection.classPass === undefined ? "none" : "selected" };
      if (!sameScope(bound.scope, this.#scope) || bound.bookingKind === "book" && bound.passUse !== "none") return ok(undefined);
      const began = approvalInstant(this.#clock()); if (began === undefined || began < this.#capturedAt) return err({ kind: "unavailable" });
      const found = await bounded(signal, this.#deadlineMs, () => this.#source.current(this.#scope));
      const end = approvalInstant(this.#clock());
      if (!found || end === undefined || end < began || signal.aborted) return err({ kind: "unavailable" });
      if (!found.ok || !found.value) return found;
      const policy = found.value;
      if (end < Date.parse(policy.effectiveFrom) || end >= Date.parse(policy.effectiveUntil) ||
          Object.entries(policy.selection).some(([key, value]) => bound[key as keyof typeof bound] !== value)) return ok(undefined);
      return ok(Object.freeze({ ...policy, scope: Object.freeze({ ...policy.scope }), selection: Object.freeze({ ...policy.selection }), terms: Object.freeze({ ...policy.terms }) }));
    } catch { return err({ kind: "unavailable" }); }
  }
}
