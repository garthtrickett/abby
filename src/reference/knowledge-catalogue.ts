import type { KnowledgeHost, KnowledgeReadFailure, ModelKnowledgeContextHost } from "../core/host.ts";
import { validKnowledgeSource } from "../core/knowledge-evidence.ts";
import { err, ok } from "../core/model.ts";
import type { ApprovedKnowledge, LocationScope, Result } from "../core/model.ts";

export type KnowledgeEntry = Readonly<{
  scope: LocationScope;
  sourceRef: string;
  version: string;
  status: "draft" | "approved" | "revoked";
  ownerRef: string;
  text: string;
  effectiveFrom: string;
  effectiveUntil: string;
  actorRef: string;
  changedAt: string;
}>;

export type KnowledgeFailure = Readonly<{ kind: "invalidValue" | "versionConflict" | "storageFailure" }>;

export interface KnowledgeCatalogue extends KnowledgeHost, ModelKnowledgeContextHost {
  list(scope: LocationScope): Promise<Result<readonly KnowledgeEntry[], KnowledgeFailure>>;
  saveDraft(scope: LocationScope, sourceRef: string, expectedVersion: string, ownerRef: string,
    text: string, effectiveFrom: string, effectiveUntil: string, actorRef: string): Promise<Result<KnowledgeEntry, KnowledgeFailure>>;
  approve(scope: LocationScope, sourceRef: string, expectedVersion: string, actorRef: string): Promise<Result<KnowledgeEntry, KnowledgeFailure>>;
  revoke(scope: LocationScope, sourceRef: string, expectedVersion: string, actorRef: string): Promise<Result<KnowledgeEntry, KnowledgeFailure>>;
}

function scopeKey(scope: LocationScope): string {
  return JSON.stringify([scope.tenantId, scope.clinicId, scope.locationId]);
}

function key(scope: LocationScope, sourceRef: string): string {
  return `${scopeKey(scope)}:${sourceRef}`;
}

function validRef(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256;
}

function validPeriod(from: string, until: string): boolean {
  return Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(until)) && Date.parse(from) < Date.parse(until);
}

function nextVersion(history: readonly KnowledgeEntry[]): string {
  const used = new Set(history.map(entry => entry.version));
  let next = history.length + 1;
  while (used.has(String(next))) next += 1;
  return String(next);
}

/** Reference implementation; the host's durable catalog implements the same port. */
export class MemoryKnowledgeCatalogue implements KnowledgeCatalogue {
  private readonly entries = new Map<string, KnowledgeEntry[]>();

  constructor(initial: readonly ApprovedKnowledge[] = []) {
    for (const source of initial) {
      if (!validRef(source.sourceRef) || !validRef(source.version) || source.version.length > 128 ||
          !validRef(source.ownerRef) || !validPeriod(source.effectiveFrom, source.effectiveUntil) ||
          !source.approved || !source.approvedText.trim() || source.approvedText.length > 2_000) throw new Error("invalid initial knowledge");
      const sourceKey = key(source.scope, source.sourceRef);
      if (this.entries.has(sourceKey)) throw new Error("duplicate initial knowledge source");
      this.entries.set(sourceKey, [{ scope: structuredClone(source.scope), sourceRef: source.sourceRef, version: source.version,
        status: "approved", ownerRef: source.ownerRef, text: source.approvedText, effectiveFrom: source.effectiveFrom,
        effectiveUntil: source.effectiveUntil, actorRef: source.ownerRef, changedAt: source.effectiveFrom }]);
    }
  }

  async list(scope: LocationScope): Promise<Result<readonly KnowledgeEntry[], KnowledgeFailure>> {
    const rows = [...this.entries.values()].flatMap(entries => entries.filter(entry => scopeKey(entry.scope) === scopeKey(scope)));
    return ok(structuredClone(rows.sort((a, b) => a.sourceRef.localeCompare(b.sourceRef))));
  }

  async saveDraft(scope: LocationScope, sourceRef: string, expectedVersion: string, ownerRef: string,
    text: string, effectiveFrom: string, effectiveUntil: string, actorRef: string): Promise<Result<KnowledgeEntry, KnowledgeFailure>> {
    if (![sourceRef, ownerRef, actorRef].every(validRef) || typeof text !== "string" || !text.trim() || text.length > 2_000 ||
        !validPeriod(effectiveFrom, effectiveUntil)) return err({ kind: "invalidValue" });
    const history = this.entries.get(key(scope, sourceRef)) ?? [];
    if ((history.at(-1)?.version ?? "0") !== expectedVersion) return err({ kind: "versionConflict" });
    const next = nextVersion(history);
    const entry: KnowledgeEntry = { scope: structuredClone(scope), sourceRef, version: next, status: "draft", ownerRef, text,
      effectiveFrom, effectiveUntil, actorRef, changedAt: new Date().toISOString() };
    this.entries.set(key(scope, sourceRef), [...history, entry]);
    return ok(structuredClone(entry));
  }

  async approve(scope: LocationScope, sourceRef: string, expectedVersion: string, actorRef: string): Promise<Result<KnowledgeEntry, KnowledgeFailure>> {
    if (!validRef(sourceRef) || !validRef(actorRef)) return err({ kind: "invalidValue" });
    const history = this.entries.get(key(scope, sourceRef)) ?? [];
    const current = history.at(-1);
    if (!current || current.version !== expectedVersion) return err({ kind: "versionConflict" });
    if (current.status !== "draft") return err({ kind: "invalidValue" });
    const entry: KnowledgeEntry = { ...current, version: nextVersion(history), status: "approved", actorRef, changedAt: new Date().toISOString() };
    this.entries.set(key(scope, sourceRef), [...history, entry]);
    return ok(structuredClone(entry));
  }

  async revoke(scope: LocationScope, sourceRef: string, expectedVersion: string, actorRef: string): Promise<Result<KnowledgeEntry, KnowledgeFailure>> {
    if (!validRef(sourceRef) || !validRef(actorRef)) return err({ kind: "invalidValue" });
    const history = this.entries.get(key(scope, sourceRef)) ?? [];
    const current = history.at(-1);
    if (!current || current.version !== expectedVersion) return err({ kind: "versionConflict" });
    const published = [...history].reverse().find(entry => entry.status !== "draft");
    if (published?.status !== "approved") return err({ kind: "invalidValue" });
    const entry: KnowledgeEntry = { ...published, version: nextVersion(history), status: "revoked", actorRef, changedAt: new Date().toISOString() };
    this.entries.set(key(scope, sourceRef), [...history, entry]);
    return ok(structuredClone(entry));
  }

  private effective(scope: LocationScope): readonly ApprovedKnowledge[] {
    const result: ApprovedKnowledge[] = [];
    for (const history of this.entries.values()) {
      if (!history.length || scopeKey(history[0]!.scope) !== scopeKey(scope)) continue;
      const latest = [...history].reverse().find(entry => entry.status !== "draft");
      if (latest?.status === "approved") result.push({ scope: latest.scope, sourceRef: latest.sourceRef, version: latest.version,
        ownerRef: latest.ownerRef, approvedText: latest.text, approved: true,
        effectiveFrom: latest.effectiveFrom, effectiveUntil: latest.effectiveUntil });
    }
    return result;
  }

  async readKnowledge(scope: LocationScope, sourceRefs: readonly string[]): Promise<Result<readonly ApprovedKnowledge[], KnowledgeReadFailure>> {
    if (!Array.isArray(sourceRefs) || sourceRefs.length < 1 || sourceRefs.length > 8 ||
        sourceRefs.some(ref => !validRef(ref)) || new Set(sourceRefs).size !== sourceRefs.length) return err({ kind: "invalidQuery" });
    return ok(structuredClone(this.effective(scope).filter(source => sourceRefs.includes(source.sourceRef))));
  }

  async listModelKnowledge(scope: LocationScope, now: string): Promise<Result<readonly ApprovedKnowledge[], KnowledgeReadFailure>> {
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidQuery" });
    return ok(structuredClone(this.effective(scope).filter(source => validKnowledgeSource(source, scope, now))));
  }
}
