import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval, approvalInstant } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval, ClinicApprovalFailure } from "./owner-file-clinic-approval.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";
import type { OutboundContactSourceSelection } from "../cliniko/internal/outbound-contact-source-context.ts";

/** Non-patient source definition only. Patient IDs, phones, decisions and head
 * pointers never belong in this local approval file. */
export type OutboundContactSourceApproval = ClinicApproval & Readonly<{
  source: Readonly<Omit<OutboundContactSourceSelection, "scope">>;
}>;
type Config = Readonly<{ path: string; scope: LocationScope; directory: AdminDirectory; clock?: () => string; deadlineMs?: number }>;
function decode(value: unknown, scope: LocationScope): OutboundContactSourceApproval | undefined {
  const common = decodeClinicApproval(value, scope, [...clinicApprovalKeys, "source"]);
  if (!common) return undefined;
  const source = (value as OutboundContactSourceApproval).source;
  if (!source || typeof source !== "object" || Array.isArray(source) || Object.keys(source).sort().join(",") !==
    "businessId,contactPolicyDigest,contactPolicyVersion,contactReviewRecallTypeId,countryCallingCode,credentialFingerprint" ||
    !validClinikoId(source.businessId) || !validClinikoId(source.contactReviewRecallTypeId) ||
    [source.credentialFingerprint, source.contactPolicyDigest, source.contactPolicyVersion, source.countryCallingCode].some(v => typeof v !== "string") ||
    !/^[a-f0-9]{64}$/.test(source.credentialFingerprint) || !/^[a-f0-9]{64}$/.test(source.contactPolicyDigest) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(source.contactPolicyVersion) || !/^[1-9][0-9]{0,2}$/.test(source.countryCallingCode)) return undefined;
  return value as OutboundContactSourceApproval;
}
async function bounded<T>(signal: AbortSignal, ms: number, task: () => Promise<T>): Promise<T | undefined> {
  if (!(signal instanceof AbortSignal) || signal.aborted) return undefined;
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), ms), combined = AbortSignal.any([signal, deadline.signal]), began = performance.now();
  try { const found = await awaitUntilAbort(Promise.resolve().then(task), combined); return combined.aborted || performance.now() - began > ms ? undefined : found; }
  catch { return undefined; } finally { clearTimeout(timer); deadline.abort(); }
}
export class OwnerFileOutboundContactSource {
  readonly #source: OwnerFileClinicApproval<OutboundContactSourceApproval>;
  readonly #scope: LocationScope;
  readonly #clock: () => string;
  readonly #deadlineMs: number;
  readonly #capturedAt: number;
  private constructor(source: OwnerFileClinicApproval<OutboundContactSourceApproval>, config: Config, clock: () => string, capturedAt: number) {
    this.#source = source; this.#scope = Object.freeze({ ...config.scope }); this.#clock = clock; this.#deadlineMs = config.deadlineMs ?? 15000; this.#capturedAt = capturedAt;
  }
  static async capture(config: Config, signal: AbortSignal): Promise<Result<OwnerFileOutboundContactSource, ClinicApprovalFailure>> {
    try {
      const ms = config.deadlineMs ?? 15000;
      if (!Number.isSafeInteger(ms) || ms < 1 || ms > 15000 || typeof config.directory?.findByRef !== "function" ||
        typeof config.directory.findByEmail !== "function" || config.clock !== undefined && typeof config.clock !== "function") return err({ kind: "unavailable" });
      const clock = config.clock?.bind(config) ?? (() => new Date().toISOString()), at = approvalInstant(clock()); if (at === undefined) return err({ kind: "unavailable" });
      const directory = Object.freeze({ findByRef: config.directory.findByRef.bind(config.directory), findByEmail: config.directory.findByEmail.bind(config.directory) });
      const captured = Object.freeze({ path: config.path, scope: Object.freeze({ ...config.scope }), directory, clock, deadlineMs: ms });
      const source = await bounded(signal, ms, () => OwnerFileClinicApproval.capture({ ...captured, decode }));
      const end = approvalInstant(clock()); if (!source?.ok || end === undefined || end < at || signal.aborted) return err({ kind: "unavailable" });
      return ok(new OwnerFileOutboundContactSource(source.value, captured, clock, at));
    } catch { return err({ kind: "unavailable" }); }
  }
  /** Current clinic-admin source approval, never patient or contact permission. */
  async currentFor(selection: OutboundContactSourceSelection, signal: AbortSignal): Promise<Result<boolean, ClinicApprovalFailure>> {
    try {
      const bound = Object.freeze({ ...selection, scope: Object.freeze({ ...selection.scope }) });
      const began = approvalInstant(this.#clock()); if (began === undefined || began < this.#capturedAt) return err({ kind: "unavailable" });
      const found = await bounded(signal, this.#deadlineMs, () => this.#source.current(this.#scope));
      const end = approvalInstant(this.#clock()); if (!found || end === undefined || end < began || signal.aborted) return err({ kind: "unavailable" });
      if (!found.ok) return found; if (!found.value) return ok(false);
      const source = found.value.source;
      return ok(sameScope(bound.scope, this.#scope) && Object.keys(bound).sort().join(",") ===
        "businessId,contactPolicyDigest,contactPolicyVersion,contactReviewRecallTypeId,countryCallingCode,credentialFingerprint,scope" &&
        bound.businessId === source.businessId && bound.credentialFingerprint === source.credentialFingerprint &&
        bound.contactReviewRecallTypeId === source.contactReviewRecallTypeId && bound.contactPolicyVersion === source.contactPolicyVersion &&
        bound.contactPolicyDigest === source.contactPolicyDigest && bound.countryCallingCode === source.countryCallingCode &&
        end >= Date.parse(found.value.effectiveFrom) && end < Date.parse(found.value.effectiveUntil));
    } catch { return err({ kind: "unavailable" }); }
  }
}
