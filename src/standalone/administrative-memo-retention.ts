import { isDeepStrictEqual } from "node:util";
import { administrativeMemoDigest, AdministrativeMemoAuthentication } from "../cliniko/administrative-memo.ts";
import type { AdministrativeMemo } from "../cliniko/administrative-memo.ts";
import { administrativeMemoRecordBinding, ClinikoAdministrativeMemos } from "../cliniko/administrative-memo-records.ts";
import type { AdministrativeMemoConfig, AdministrativeMemoQuery, AdministrativeMemoRetention, AdministrativeMemoWriteAuthority } from "../cliniko/administrative-memo-records.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import type { LocationScope } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";

export type MemoRetentionOutcome = AdministrativeMemoRetention | Readonly<{ kind: "unavailable" }>;
export type ClinikoAdministrativeMemoConfig = Readonly<{
  native: AdministrativeMemoConfig; authentication: AdministrativeMemoAuthentication;
  authority: AdministrativeMemoWriteAuthority; barrier: OutboundEffectBarrier;
  /** Independent service-owned lifetime, granting no clinical continuation. */
  memoSignal: AbortSignal; fetchPort?: typeof fetch;
  observeOutcome?: (outcome: MemoRetentionOutcome) => void;
}>;

/** Capture clinic-owned ports before asynchronous workflow selection. */
export function captureAdministrativeMemoConfig(config: ClinikoAdministrativeMemoConfig,
  binding: Readonly<{ scope: LocationScope; businessId: string; credentialFingerprint: string; rateBudget: ClinikoRequestBudget; clock?: () => string }>): ClinikoAdministrativeMemoConfig {
  const owner = administrativeMemoRecordBinding(config.native, config.authentication);
  if (!(config.authentication instanceof AdministrativeMemoAuthentication) || !(config.memoSignal instanceof AbortSignal) || !owner ||
      !isDeepStrictEqual(config.native.scope, binding.scope) || config.native.businessId !== binding.businessId ||
      clinikoCredentialFingerprint(config.native.apiKey) !== binding.credentialFingerprint || config.native.rateBudget !== binding.rateBudget ||
      [config.authority?.allows, config.authority?.current, config.authority?.producerAdmitted, config.barrier?.matches, config.barrier?.claimOnce].some(f => typeof f !== "function") ||
      config.barrier.matches(binding.scope, owner) !== true || config.observeOutcome !== undefined && typeof config.observeOutcome !== "function")
    throw Error("Invalid administrative memo selection");
  const clock = config.native.clock?.bind(config.native) ?? binding.clock?.bind(binding) ?? (() => new Date().toISOString());
  return Object.freeze({ ...config, native: Object.freeze({ ...config.native, scope: Object.freeze({ ...config.native.scope }), policy: Object.freeze({ ...config.native.policy }), clock }),
    authority: Object.freeze({ allows: config.authority.allows.bind(config.authority), current: config.authority.current.bind(config.authority), producerAdmitted: config.authority.producerAdmitted.bind(config.authority) }),
    barrier: Object.freeze({ matches: config.barrier.matches.bind(config.barrier), claimOnce: config.barrier.claimOnce.bind(config.barrier) }),
    ...(config.observeOutcome ? { observeOutcome: config.observeOutcome.bind(config) } : {}) });
}

/** A verified producer owns source capture. This module owns only the separately
 * permitted native effect and private disclosure of its eventual outcome. */
export async function retainAdministrativeMemo(c: ClinikoAdministrativeMemoConfig, memo: AdministrativeMemo | undefined): Promise<void> {
  const fingerprint = memo && administrativeMemoDigest(memo);
  let outcome: MemoRetentionOutcome = { kind: "unavailable" }, last: AdministrativeMemoQuery | undefined;
  const current = (q: AdministrativeMemoQuery, signal: AbortSignal) => {
    last = q; return !signal.aborted && !!fingerprint && q.memoDigest === fingerprint && c.authority.current(q, signal) === true;
  };
  try {
    if (memo && fingerprint) {
      const native = ClinikoAdministrativeMemos.create(c.native, c.authentication, { allows: c.authority.allows, current,
        producerAdmitted: (q, signal) => q.memoDigest === fingerprint ? c.authority.producerAdmitted(q, signal) : Promise.resolve(false) }, c.barrier, c.fetchPort);
      if (native.ok) { const result = await native.value.retainOnce(memo, c.memoSignal); if (result.ok) outcome = result.value; }
    }
    if (outcome.kind === "accepted") {
      let disclose = false; try { disclose = !!last && current(last, c.memoSignal); } catch {}
      if (!disclose) outcome = { kind: "acceptedWithheld" };
    }
  } catch { /* An administrative failure cannot change the clinical result. */ }
  try { if (c.observeOutcome) void Promise.resolve(c.observeOutcome(outcome)).catch(() => {}); }
  catch { /* Private observers cannot veto either effect. */ }
}
