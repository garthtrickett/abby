import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { approvalInstant, approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval, ClinicApprovalFailure } from "./owner-file-clinic-approval.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { sameScope, validClinikoId } from "./appointment-change-authority.ts";
import { contactSourceBinding } from "../cliniko/internal/outbound-contact-source-context.ts";
import type { OutboundContactSourceSelection } from "../cliniko/internal/outbound-contact-source-context.ts";
import type { OutboundContactDefinition } from "../cliniko/outbound-contact-source.ts";

export type OutboundContactAccount = Readonly<{ ref: string; credentialFingerprints: readonly string[];
  coverage: "allCurrentAndRetiredVoiceContactSources"; sources: readonly OutboundContactSourceSelection[] }>;
export type OutboundContactAccountApproval = ClinicApproval & Readonly<{ account: OutboundContactAccount }>;
type Source = Readonly<{ selection: OutboundContactSourceSelection; definition: OutboundContactDefinition }>;
type Config = Readonly<{ path: string; scope: LocationScope; credentialFingerprint: string; directory: AdminDirectory;
  definitions: readonly Source[]; clock?: () => string; deadlineMs?: number }>;
const exact = (v: unknown, keys: readonly string[]) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const fingerprint = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function sourceValid(s: OutboundContactSourceSelection, scope: LocationScope): boolean {
  return exact(s, ["scope", "businessId", "credentialFingerprint", "contactReviewRecallTypeId", "contactPolicyVersion", "contactPolicyDigest", "countryCallingCode"]) &&
    exact(s.scope, ["tenantId", "clinicId", "locationId"]) && [s.scope.tenantId, s.scope.clinicId, s.scope.locationId].every(approvalRef) &&
    s.scope.tenantId === scope.tenantId && s.scope.clinicId === scope.clinicId && validClinikoId(s.businessId) && validClinikoId(s.contactReviewRecallTypeId) &&
    fingerprint(s.credentialFingerprint) && fingerprint(s.contactPolicyDigest) && typeof s.contactPolicyVersion === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(s.contactPolicyVersion) &&
    typeof s.countryCallingCode === "string" && /^[1-9][0-9]{0,2}$/.test(s.countryCallingCode);
}
function decode(v: unknown, scope: LocationScope): OutboundContactAccountApproval | undefined {
  const common = decodeClinicApproval(v, scope, [...clinicApprovalKeys, "account"]); if (!common) return undefined;
  const account = (v as OutboundContactAccountApproval).account;
  if (!exact(account, ["ref", "credentialFingerprints", "coverage", "sources"]) || !approvalRef(account.ref) ||
      account.coverage !== "allCurrentAndRetiredVoiceContactSources" || !Array.isArray(account.credentialFingerprints) ||
      account.credentialFingerprints.length < 1 || account.credentialFingerprints.length > 8 || !account.credentialFingerprints.every(fingerprint) ||
      new Set(account.credentialFingerprints).size !== account.credentialFingerprints.length || !Array.isArray(account.sources) || account.sources.length < 1 || account.sources.length > 8 ||
      !account.sources.every(s => sourceValid(s, scope) && account.credentialFingerprints.includes(s.credentialFingerprint)) ||
      new Set(account.sources.map(contactSourceBinding)).size !== account.sources.length) return undefined;
  return v as OutboundContactAccountApproval;
}
const sourcesKey = (sources: readonly OutboundContactSourceSelection[]) => sources.map(contactSourceBinding).sort().join(",");

/** Non-patient account/source-role coverage only. The clinic explicitly attests
 * that current AND retired authoritative roles and credential aliases are listed.
 * Every role retains its independent current clinic source definition. This does
 * not grant broad private reads, resolve a number stop or authorize a call. */
export class OwnerFileOutboundContactAccount {
  readonly #source: OwnerFileClinicApproval<OutboundContactAccountApproval>;
  readonly #scope: LocationScope;
  readonly #fingerprint: string;
  readonly #definitions: readonly Source[];
  readonly #clock: () => string;
  readonly #at: number;
  readonly #ms: number;
  private constructor(source: OwnerFileClinicApproval<OutboundContactAccountApproval>, c: Config, at: number) {
    this.#source = source; this.#scope = Object.freeze({ ...c.scope }); this.#fingerprint = c.credentialFingerprint;
    this.#definitions = Object.freeze(c.definitions.map(s => Object.freeze({ selection: Object.freeze({ ...s.selection, scope: Object.freeze({ ...s.selection.scope }) }),
      definition: Object.freeze({ currentFor: s.definition.currentFor.bind(s.definition) }) })));
    this.#clock = c.clock ? c.clock.bind(c) : () => new Date().toISOString(); this.#at = at; this.#ms = c.deadlineMs ?? 15000;
  }
  matches(scope: LocationScope, credentialFingerprint: string): boolean { return sameScope(scope, this.#scope) && credentialFingerprint === this.#fingerprint; }
  bindingFingerprint(): string { return this.#source.bindingFingerprint(); }
  static async capture(c: Config, external: AbortSignal): Promise<Result<OwnerFileOutboundContactAccount, ClinicApprovalFailure>> {
    try {
      if (!(external instanceof AbortSignal) || external.aborted || !fingerprint(c.credentialFingerprint) || !Array.isArray(c.definitions) || c.definitions.length < 1 || c.definitions.length > 8 ||
          !c.definitions.every(d => sourceValid(d.selection, c.scope) && typeof d.definition?.currentFor === "function") ||
          new Set(c.definitions.map(d => contactSourceBinding(d.selection))).size !== c.definitions.length ||
          !Number.isSafeInteger(c.deadlineMs ?? 15000) || (c.deadlineMs ?? 15000) < 1 || (c.deadlineMs ?? 15000) > 15000 ||
          typeof c.directory?.findByRef !== "function" || typeof c.directory.findByEmail !== "function" || c.clock !== undefined && typeof c.clock !== "function") return err({ kind: "unavailable" });
      const at = approvalInstant(c.clock ? c.clock() : new Date().toISOString()); if (at === undefined) return err({ kind: "unavailable" });
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), c.deadlineMs ?? 15000), signal = AbortSignal.any([external, controller.signal]);
      try {
        const config = Object.freeze({ ...c, scope: Object.freeze({ ...c.scope }),
          definitions: Object.freeze(c.definitions.map(d => Object.freeze({ selection: Object.freeze({ ...d.selection, scope: Object.freeze({ ...d.selection.scope }) }),
            definition: Object.freeze({ currentFor: d.definition.currentFor.bind(d.definition) }) }))), ...(c.clock ? { clock: c.clock.bind(c) } : {}),
          directory: Object.freeze({ findByRef: c.directory.findByRef.bind(c.directory), findByEmail: c.directory.findByEmail.bind(c.directory) }) });
        const loaded = await awaitUntilAbort(OwnerFileClinicApproval.capture({ ...config, decode }), signal);
        if (!loaded?.ok || signal.aborted) return err({ kind: "unavailable" });
        const owner = new OwnerFileOutboundContactAccount(loaded.value, config, at), current = await owner.current(signal);
        return current.ok && current.value ? ok(owner) : err({ kind: "unavailable" });
      } finally { clearTimeout(timer); controller.abort(); }
    } catch { return err({ kind: "unavailable" }); }
  }
  async current(external: AbortSignal): Promise<Result<OutboundContactAccountApproval | undefined, ClinicApprovalFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.#ms), signal = AbortSignal.any([external, controller.signal]), began = performance.now();
    let last = this.#at;
    const time = () => { const at = approvalInstant(this.#clock()); if (at === undefined || at < last || signal.aborted || performance.now() - began > this.#ms) throw Error("Unavailable account source time"); last = at; };
    const wait = async <T>(task: Promise<T>): Promise<T> => { const r = await awaitUntilAbort(task, signal); if (r === undefined) throw Error("Unavailable account source"); time(); return r; };
    try {
      time(); const loaded = await wait(this.#source.current(this.#scope)); if (!loaded.ok) return loaded;
      const policy = loaded.value; if (!policy) return ok(undefined);
      if (!policy.account.credentialFingerprints.includes(this.#fingerprint) || sourcesKey(policy.account.sources) !== sourcesKey(this.#definitions.map(d => d.selection))) return err({ kind: "unavailable" });
      for (const d of this.#definitions) { const source = await wait(d.definition.currentFor(d.selection, signal)); if (!source.ok || source.value !== true) return err({ kind: "unavailable" }); }
      const again = await wait(this.#source.current(this.#scope));
      if (!again.ok || !again.value || !isDeepStrictEqual(policy, again.value)) return err({ kind: "unavailable" });
      return ok(Object.freeze({ ...policy, scope: Object.freeze({ ...policy.scope }), account: Object.freeze({ ...policy.account,
        credentialFingerprints: Object.freeze([...policy.account.credentialFingerprints]), sources: Object.freeze(policy.account.sources.map(s => Object.freeze({ ...s, scope: Object.freeze({ ...s.scope }) }))) }) }));
    } catch { return err({ kind: "unavailable" }); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
