import type { KnowledgeHost, KnowledgeReadFailure, ModelKnowledgeContextHost, PolicyStore } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { ApprovedKnowledge, LocationScope, Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import type { AdminDirectory } from "./identity/magic-link.ts";
import { approvalRef, clinicApprovalKeys, decodeClinicApproval, OwnerFileClinicApproval } from "./owner-file-clinic-approval.ts";
import type { ClinicApproval } from "./owner-file-clinic-approval.ts";

export const clinicFAQTopics = ["directionsAndParking", "openingHours", "contact"] as const;
export type ClinicFAQTopic = typeof clinicFAQTopics[number];
export type ClinicFAQApproval = ClinicApproval & Readonly<{ policyVersion: string;
  facts: readonly Readonly<{ topic: ClinicFAQTopic; approvedText: string }>[] }>;
type Config = Readonly<{ path: string; scope: LocationScope; policyVersion: string; policies: Pick<PolicyStore, "read">; directory: AdminDirectory; clock?: () => string }>;
function decode(value: unknown, scope: LocationScope): ClinicFAQApproval | undefined {
  if (!decodeClinicApproval(value, scope, [...clinicApprovalKeys, "policyVersion", "facts"])) return undefined;
  const row = value as ClinicFAQApproval;
  if (!approvalRef(row.policyVersion) || !Array.isArray(row.facts) || row.facts.length > 3 ||
      new Set(row.facts.map(fact => fact?.topic)).size !== row.facts.length || row.facts.some(fact =>
        !fact || Object.keys(fact).sort().join(",") !== "approvedText,topic" || !clinicFAQTopics.includes(fact.topic) ||
        typeof fact.approvedText !== "string" || !fact.approvedText.trim() || fact.approvedText.length > 1_000 || /[\x00-\x1f\x7f]/.test(fact.approvedText))) return undefined;
  return row;
}
/** Operator-provisioned, already public clinic facts only. No caller, patient-note,
 * model or database editor can write this file. Admin approval is not a PHI detector:
 * the operator must provision published public material, never patient content. */
export class OwnerFileClinicFAQs implements KnowledgeHost, ModelKnowledgeContextHost {
  readonly #config: Config;
  constructor(config: Config) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
  }
  async #read(scope: LocationScope): Promise<Result<readonly ApprovedKnowledge[], KnowledgeReadFailure>> {
    const signal = AbortSignal.timeout(5_000);
    try {
      const permitted = await awaitUntilAbort(this.#config.policies.read(scope), signal);
      if (!permitted?.ok || !permitted.value.automationEnabled || permitted.value.policyVersion !== this.#config.policyVersion) return ok([]);
      const captured = await awaitUntilAbort(OwnerFileClinicApproval.capture({ ...this.#config, decode }), signal);
      if (!captured?.ok) return err({ kind: "unavailable" });
      const currentPolicy = await awaitUntilAbort(this.#config.policies.read(scope), signal);
      if (!currentPolicy?.ok || !currentPolicy.value.automationEnabled || currentPolicy.value.policyVersion !== this.#config.policyVersion) return ok([]);
      const found = await awaitUntilAbort(captured.value.current(scope), signal);
      if (!found?.ok) return err({ kind: "unavailable" });
      const row = found.value;
      if (!row || row.policyVersion !== this.#config.policyVersion) return ok([]);
      // Pin the whole approved content, not only an operator's revision label.
      // Replacing text without changing that label still invalidates old calls.
      const version = captured.value.bindingFingerprint();
      return ok(clinicFAQTopics.flatMap(topic => {
        const fact = row.facts.find(item => item.topic === topic);
        return fact ? [{ scope: { ...row.scope }, sourceRef: `clinic-public-${topic}`, version, ownerRef: row.approverRef,
          approvedText: fact.approvedText, approved: true, effectiveFrom: row.effectiveFrom, effectiveUntil: row.effectiveUntil }] : [];
      }));
    } catch { return err({ kind: "unavailable" }); }
  }
  async readKnowledge(scope: LocationScope, refs: readonly string[]): Promise<Result<readonly ApprovedKnowledge[], KnowledgeReadFailure>> {
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > 8 || new Set(refs).size !== refs.length ||
        refs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 256)) return err({ kind: "invalidQuery" });
    const found = await this.#read(scope);
    return found.ok ? ok(found.value.filter(fact => refs.includes(fact.sourceRef))) : found;
  }
  async listModelKnowledge(scope: LocationScope, now: string): Promise<Result<readonly ApprovedKnowledge[], KnowledgeReadFailure>> {
    if (typeof now !== "string" || !Number.isFinite(Date.parse(now))) return err({ kind: "invalidQuery" });
    const found = await this.#read(scope);
    return found.ok ? ok(found.value.filter(fact => Date.parse(fact.effectiveFrom) <= Date.parse(now) && Date.parse(now) < Date.parse(fact.effectiveUntil))) : found;
  }
}
