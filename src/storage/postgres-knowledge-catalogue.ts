import { sql } from "kysely";
import type { Kysely } from "kysely";
import { validKnowledgeSource } from "../core/knowledge-evidence.ts";
import { err, ok } from "../core/model.ts";
import type { ApprovedKnowledge, LocationScope, Result } from "../core/model.ts";
import type { KnowledgeReadFailure } from "../core/host.ts";
import type { KnowledgeCatalogue, KnowledgeEntry, KnowledgeFailure } from "../reference/knowledge-catalogue.ts";
import type Database from "./generated/Database.ts";

type Head = { version: number; effective_version: number | null };
type Row = { source_ref: string; version: number; status: string; owner_ref: string; answer_text: string;
  effective_from: Date; effective_until: Date; actor_ref: string; changed_at: Date };

function validRef(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256;
}

function validPeriod(from: string, until: string): boolean {
  return Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(until)) && Date.parse(from) < Date.parse(until);
}

function decode(scope: LocationScope, row: Row): KnowledgeEntry {
  if (!validRef(row.source_ref) || !validRef(row.owner_ref) || !validRef(row.actor_ref) ||
      !Number.isSafeInteger(row.version) || row.version < 1 ||
      !["draft", "approved", "revoked"].includes(row.status) ||
      typeof row.answer_text !== "string" || !row.answer_text.trim() || row.answer_text.length > 2_000 ||
      !(row.effective_from instanceof Date) || !(row.effective_until instanceof Date) || !(row.changed_at instanceof Date) ||
      !Number.isFinite(row.effective_from.getTime()) || !Number.isFinite(row.effective_until.getTime()) ||
      !Number.isFinite(row.changed_at.getTime())) throw new Error("corrupt knowledge row");
  return { scope: structuredClone(scope), sourceRef: row.source_ref, version: String(row.version),
    status: row.status as KnowledgeEntry["status"], ownerRef: row.owner_ref, text: row.answer_text,
    effectiveFrom: row.effective_from.toISOString(), effectiveUntil: row.effective_until.toISOString(),
    actorRef: row.actor_ref, changedAt: row.changed_at.toISOString() };
}

function approved(entry: KnowledgeEntry): ApprovedKnowledge {
  return { scope: entry.scope, sourceRef: entry.sourceRef, version: entry.version, ownerRef: entry.ownerRef,
    approvedText: entry.text, approved: true, effectiveFrom: entry.effectiveFrom, effectiveUntil: entry.effectiveUntil };
}

export class PostgresKnowledgeCatalogue implements KnowledgeCatalogue {
  private readonly db: Kysely<Database>;
  private readonly mode: "standaloneDisabled" | "unsafeReference";

  /** Durable free-text knowledge requires a separate patient-data-safe content workflow. */
  constructor(db: Kysely<Database>, mode: "standaloneDisabled" | "unsafeReference" = "standaloneDisabled") {
    this.db = db;
    this.mode = mode;
  }

  async list(scope: LocationScope): Promise<Result<readonly KnowledgeEntry[], KnowledgeFailure>> {
    if (this.mode === "standaloneDisabled") return err({ kind: "storageFailure" });
    try {
      const result = await sql<Row>`select source_ref, version, status, owner_ref, answer_text, effective_from,
        effective_until, actor_ref, changed_at from clinic_knowledge_events
        where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId} and location_id = ${scope.locationId}
        order by source_ref, version`.execute(this.db);
      return ok(result.rows.map(row => decode(scope, row)));
    } catch { return err({ kind: "storageFailure" }); }
  }

  async saveDraft(scope: LocationScope, sourceRef: string, expectedVersion: string, ownerRef: string,
    text: string, effectiveFrom: string, effectiveUntil: string, actorRef: string): Promise<Result<KnowledgeEntry, KnowledgeFailure>> {
    if (this.mode === "standaloneDisabled") return err({ kind: "invalidValue" });
    if (![sourceRef, ownerRef, actorRef].every(validRef) || typeof text !== "string" || !text.trim() || text.length > 2_000 ||
        !validPeriod(effectiveFrom, effectiveUntil)) return err({ kind: "invalidValue" });
    return this.change(scope, sourceRef, expectedVersion, actorRef, "draft", { ownerRef, text, effectiveFrom, effectiveUntil });
  }

  async approve(scope: LocationScope, sourceRef: string, expectedVersion: string, actorRef: string): Promise<Result<KnowledgeEntry, KnowledgeFailure>> {
    if (this.mode === "standaloneDisabled") return err({ kind: "invalidValue" });
    if (!validRef(sourceRef) || !validRef(actorRef)) return err({ kind: "invalidValue" });
    return this.change(scope, sourceRef, expectedVersion, actorRef, "approved");
  }

  async revoke(scope: LocationScope, sourceRef: string, expectedVersion: string, actorRef: string): Promise<Result<KnowledgeEntry, KnowledgeFailure>> {
    if (this.mode === "standaloneDisabled") return err({ kind: "invalidValue" });
    if (!validRef(sourceRef) || !validRef(actorRef)) return err({ kind: "invalidValue" });
    return this.change(scope, sourceRef, expectedVersion, actorRef, "revoked");
  }

  private async change(scope: LocationScope, sourceRef: string, expectedVersion: string, actorRef: string,
    status: KnowledgeEntry["status"], draft?: { ownerRef: string; text: string; effectiveFrom: string; effectiveUntil: string }): Promise<Result<KnowledgeEntry, KnowledgeFailure>> {
    try {
      return await this.db.transaction().execute(async trx => {
        if (status === "draft") await sql`insert into clinic_knowledge_heads (tenant_id, clinic_id, location_id, source_ref)
          values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, ${sourceRef}) on conflict do nothing`.execute(trx);
        const head = (await sql<Head>`select version, effective_version from clinic_knowledge_heads
          where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId} and location_id = ${scope.locationId}
          and source_ref = ${sourceRef} for update`.execute(trx)).rows[0];
        if (!head || String(head.version) !== expectedVersion) return err({ kind: "versionConflict" });
        if (!Number.isSafeInteger(head.version) || head.version < 0 || head.version >= Number.MAX_SAFE_INTEGER) return err({ kind: "storageFailure" });
        let details = draft;
        if (status !== "draft") {
          const sourceVersion = status === "approved" ? head.version : head.effective_version;
          if (sourceVersion === null) return err({ kind: "invalidValue" });
          const source = (await sql<Row>`select source_ref, version, status, owner_ref, answer_text, effective_from,
            effective_until, actor_ref, changed_at from clinic_knowledge_events
            where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId} and location_id = ${scope.locationId}
            and source_ref = ${sourceRef} and version = ${sourceVersion}`.execute(trx)).rows[0];
          if (!source) return err({ kind: "storageFailure" });
          if (status === "approved" && source.status !== "draft") return err({ kind: "invalidValue" });
          if (status === "revoked" && source.status !== "approved") return err({ kind: "storageFailure" });
          details = { ownerRef: source.owner_ref, text: source.answer_text,
            effectiveFrom: source.effective_from.toISOString(), effectiveUntil: source.effective_until.toISOString() };
        }
        if (!details) return err({ kind: "storageFailure" });
        const nextVersion = head.version + 1;
        const inserted = (await sql<Row>`insert into clinic_knowledge_events (tenant_id, clinic_id, location_id, source_ref,
          version, status, owner_ref, answer_text, effective_from, effective_until, actor_ref)
          values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, ${sourceRef}, ${nextVersion}, ${status},
            ${details.ownerRef}, ${details.text}, ${details.effectiveFrom}::timestamptz, ${details.effectiveUntil}::timestamptz, ${actorRef})
          returning source_ref, version, status, owner_ref, answer_text, effective_from, effective_until, actor_ref, changed_at`.execute(trx)).rows[0];
        if (!inserted) return err({ kind: "storageFailure" });
        const effectiveVersion = status === "approved" ? nextVersion : status === "revoked" ? null : head.effective_version;
        await sql`update clinic_knowledge_heads set version = ${nextVersion}, effective_version = ${effectiveVersion}
          where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId} and location_id = ${scope.locationId}
          and source_ref = ${sourceRef}`.execute(trx);
        return ok(decode(scope, inserted));
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  private async effective(scope: LocationScope, sourceRefs?: readonly string[]): Promise<readonly ApprovedKnowledge[]> {
    const filter = sourceRefs ? sql`and h.source_ref in (${sql.join(sourceRefs)})` : sql``;
    const result = await sql<Row>`select e.source_ref, e.version, e.status, e.owner_ref, e.answer_text,
      e.effective_from, e.effective_until, e.actor_ref, e.changed_at from clinic_knowledge_heads h
      join clinic_knowledge_events e on e.tenant_id = h.tenant_id and e.clinic_id = h.clinic_id
      and e.location_id = h.location_id and e.source_ref = h.source_ref and e.version = h.effective_version
      where h.tenant_id = ${scope.tenantId} and h.clinic_id = ${scope.clinicId} and h.location_id = ${scope.locationId}
      ${filter} order by h.source_ref`.execute(this.db);
    return result.rows.map(row => {
      const entry = decode(scope, row);
      if (entry.status !== "approved") throw new Error("corrupt knowledge approval");
      return approved(entry);
    });
  }

  async readKnowledge(scope: LocationScope, sourceRefs: readonly string[]): Promise<Result<readonly ApprovedKnowledge[], KnowledgeReadFailure>> {
    if (this.mode === "standaloneDisabled") return err({ kind: "unavailable" });
    if (!Array.isArray(sourceRefs) || sourceRefs.length < 1 || sourceRefs.length > 8 ||
        sourceRefs.some(ref => !validRef(ref)) || new Set(sourceRefs).size !== sourceRefs.length) return err({ kind: "invalidQuery" });
    try { return ok(await this.effective(scope, sourceRefs)); }
    catch { return err({ kind: "unavailable" }); }
  }

  async listModelKnowledge(scope: LocationScope, now: string): Promise<Result<readonly ApprovedKnowledge[], KnowledgeReadFailure>> {
    if (this.mode === "standaloneDisabled") return err({ kind: "unavailable" });
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidQuery" });
    try { return ok((await this.effective(scope)).filter(source => validKnowledgeSource(source, scope, now))); }
    catch { return err({ kind: "unavailable" }); }
  }
}
