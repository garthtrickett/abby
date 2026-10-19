import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { clinicApprovalKeys, decodeClinicApproval, approvalInstant, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval, ClinicApprovalFailure } from "./owner-file-clinic-approval.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { sameScope } from "./appointment-change-authority.ts";

/** Binding is over the non-patient contact-source selection, never a number or
 * patient digest. Actual current native source permission remains independent. */
export type OutboundDncPolicySelection = Readonly<{ scope: LocationScope; sourceBinding: string;
  automationPrincipalRef: string; provider: Readonly<{ ref: string; bindingDigest: string }> }>;
export type OutboundDncPolicyApproval = ClinicApproval & Readonly<{ dnc: Omit<OutboundDncPolicySelection, "scope"> & Readonly<{
  participant: "anyAtDialledNumber"; consent: "unknown"; doNotCall: "blocked"; reconsent: "clinicApprovalOnly";
}> }>;
type Config = Readonly<{ path: string; scope: LocationScope; directory: AdminDirectory; clock?: () => string; deadlineMs?: number }>;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === keys.sort().join(",");
const opaque = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value);
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function validSelection(selection: unknown): selection is OutboundDncPolicySelection {
  return exact(selection, ["scope", "sourceBinding", "automationPrincipalRef", "provider"]) &&
    exact(selection.scope, ["tenantId", "clinicId", "locationId"]) && Object.values(selection.scope).every(opaque) &&
    hex(selection.sourceBinding) && opaque(selection.automationPrincipalRef) && exact(selection.provider, ["ref", "bindingDigest"]) &&
    opaque(selection.provider.ref) && hex(selection.provider.bindingDigest);
}
function decode(value: unknown, scope: LocationScope): OutboundDncPolicyApproval | undefined {
  const common = decodeClinicApproval(value, scope, [...clinicApprovalKeys, "dnc"]);
  if (!common) return undefined;
  const dnc = (value as OutboundDncPolicyApproval).dnc;
  if (!exact(dnc, ["sourceBinding", "automationPrincipalRef", "provider", "participant", "consent", "doNotCall", "reconsent"]) ||
    !validSelection({ scope, sourceBinding: dnc.sourceBinding, automationPrincipalRef: dnc.automationPrincipalRef, provider: dnc.provider }) ||
    dnc.automationPrincipalRef === common.approverRef || dnc.participant !== "anyAtDialledNumber" || dnc.consent !== "unknown" ||
    dnc.doNotCall !== "blocked" || dnc.reconsent !== "clinicApprovalOnly") return undefined;
  return value as OutboundDncPolicyApproval;
}
async function bounded<T>(signal: AbortSignal, ms: number, task: () => Promise<T>): Promise<T | undefined> {
  if (!(signal instanceof AbortSignal) || signal.aborted) return undefined;
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), ms), combined = AbortSignal.any([signal, deadline.signal]), began = performance.now();
  try {
    const result = await awaitUntilAbort(Promise.resolve().then(task), combined);
    return combined.aborted || performance.now() - began > ms ? undefined : result;
  } catch { return undefined; } finally { clearTimeout(timer); deadline.abort(); }
}

/** Current human clinic-admin approval of an automatic restrictive policy.
 * It supplies neither provider authentication, private record access, complete
 * producer/restore admission, current lineage-head approval nor reconsent. */
export class OwnerFileOutboundDncPolicy {
  readonly #source: OwnerFileClinicApproval<OutboundDncPolicyApproval>;
  readonly #scope: LocationScope;
  readonly #clock: () => string;
  readonly #deadlineMs: number;
  readonly #capturedAt: number;
  private constructor(source: OwnerFileClinicApproval<OutboundDncPolicyApproval>, config: Config, clock: () => string, at: number) {
    this.#source = source; this.#scope = Object.freeze({ ...config.scope }); this.#clock = clock; this.#deadlineMs = config.deadlineMs ?? 15000; this.#capturedAt = at;
  }
  static async capture(config: Config, signal: AbortSignal): Promise<Result<OwnerFileOutboundDncPolicy, ClinicApprovalFailure>> {
    try {
      const ms = config.deadlineMs ?? 15000;
      if (!Number.isSafeInteger(ms) || ms < 1 || ms > 15000 || typeof config.directory?.findByRef !== "function" ||
        typeof config.directory.findByEmail !== "function" || config.clock !== undefined && typeof config.clock !== "function") return err({ kind: "unavailable" });
      const clock = config.clock?.bind(config) ?? (() => new Date().toISOString()), at = approvalInstant(clock()); if (at === undefined) return err({ kind: "unavailable" });
      const captured = Object.freeze({ path: config.path, scope: Object.freeze({ ...config.scope }), clock, deadlineMs: ms,
        directory: Object.freeze({ findByRef: config.directory.findByRef.bind(config.directory), findByEmail: config.directory.findByEmail.bind(config.directory) }) });
      const source = await bounded(signal, ms, () => OwnerFileClinicApproval.capture({ ...captured, decode }));
      const end = approvalInstant(clock()); if (!source?.ok || end === undefined || end < at || signal.aborted) return err({ kind: "unavailable" });
      return ok(new OwnerFileOutboundDncPolicy(source.value, captured, clock, at));
    } catch { return err({ kind: "unavailable" }); }
  }
  async currentFor(selection: OutboundDncPolicySelection, signal: AbortSignal): Promise<Result<OutboundDncPolicyApproval | undefined, ClinicApprovalFailure>> {
    try {
      if (!validSelection(selection) || !sameScope(selection.scope, this.#scope)) return ok(undefined);
      const bound = { ...selection, scope: { ...selection.scope }, provider: { ...selection.provider } };
      const began = approvalInstant(this.#clock()); if (began === undefined || began < this.#capturedAt) return err({ kind: "unavailable" });
      const found = await bounded(signal, this.#deadlineMs, () => this.#source.current(this.#scope));
      const end = approvalInstant(this.#clock()); if (!found || end === undefined || end < began || signal.aborted) return err({ kind: "unavailable" });
      if (!found.ok) return found; const policy = found.value;
      if (!policy || end < Date.parse(policy.effectiveFrom) || end >= Date.parse(policy.effectiveUntil) ||
        policy.dnc.sourceBinding !== bound.sourceBinding || policy.dnc.automationPrincipalRef !== bound.automationPrincipalRef ||
        policy.dnc.provider.ref !== bound.provider.ref || policy.dnc.provider.bindingDigest !== bound.provider.bindingDigest) return ok(undefined);
      return ok(Object.freeze({ ...policy, scope: Object.freeze({ ...policy.scope }),
        dnc: Object.freeze({ ...policy.dnc, provider: Object.freeze({ ...policy.dnc.provider }) }) }));
    } catch { return err({ kind: "unavailable" }); }
  }
}
