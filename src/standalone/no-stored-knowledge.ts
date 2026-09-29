import { err, ok } from "../core/model.ts";
import type { ApprovedKnowledge, LocationScope, Result } from "../core/model.ts";
import type { KnowledgeHost, KnowledgeReadFailure, ModelKnowledgeContextHost } from "../core/host.ts";

/** Until clinic content has a proven no-patient-data path, standalone calls expose no durable free text. */
export class NoStoredKnowledge implements KnowledgeHost, ModelKnowledgeContextHost {
  async readKnowledge(_scope: LocationScope, sourceRefs: readonly string[]): Promise<Result<readonly ApprovedKnowledge[], KnowledgeReadFailure>> {
    if (!Array.isArray(sourceRefs) || sourceRefs.length < 1 || sourceRefs.length > 8 ||
        sourceRefs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 256) ||
        new Set(sourceRefs).size !== sourceRefs.length) return err({ kind: "invalidQuery" });
    return ok([]);
  }

  async listModelKnowledge(_scope: LocationScope, now: string): Promise<Result<readonly ApprovedKnowledge[], KnowledgeReadFailure>> {
    if (typeof now !== "string" || !Number.isFinite(Date.parse(now))) return err({ kind: "invalidQuery" });
    return ok([]);
  }
}
