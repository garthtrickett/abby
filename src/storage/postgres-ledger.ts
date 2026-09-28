import { sql } from "kysely";
import type { Kysely } from "kysely";
import { CALL_TERMINAL_REASONS, POSSIBLE_SEND_RECOVERY_DELAY_MS, err, ok } from "../core/model.ts";
import type { ActiveSessionReceipt, Admission, AdmissionReceipt, AdmissionResult, CallPolicy, CallState, Effect, LocationScope, PendingPresentationRef, RecoverableEffectRef, Result, StaffItem, StaffQueueEntry, TransitionAction, TransitionFailure } from "../core/model.ts";
import { admissionReceipt, initialState, sameAdmission } from "../core/ledger.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { transition } from "../core/transition.ts";
import { READINESS_REQUIREMENTS, unprovenReadiness } from "../core/readiness.ts";
import type { AutomationReadiness } from "../core/readiness.ts";
import type { WriteStopAuditPage, WriteStopFailure, WriteStopStatus } from "../core/write-stop.ts";
import type Database from "./generated/Database.ts";
import type { ClinicWriteStopClinicId, ClinicWriteStopTenantId } from "./generated/public/ClinicWriteStop.ts";
import type { ClinicWriteStopInflightEffectId } from "./generated/public/ClinicWriteStopInflight.ts";
import type { ClinicWriteStopEventsVersion } from "./generated/public/ClinicWriteStopEvents.ts";
import type { CallsCallId } from "./generated/public/Calls.ts";
import type { CallEventsSequence } from "./generated/public/CallEvents.ts";
import type { EffectOutboxEffectId } from "./generated/public/EffectOutbox.ts";
import type { StaffItemsTaskKey } from "./generated/public/StaffItems.ts";

function decodeState(value: unknown, callId: string): Result<CallState, TransitionFailure> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return err({ kind: "storageCorrupt" });
  const data = value as Record<string, unknown>;
  if (data.callId !== callId || !Number.isInteger(data.version) || !["starting", "active", "ended"].includes(String(data.lifecycle)) || typeof data.policy !== "object" || data.policy === null ||
      typeof data.actions !== "object" || data.actions === null || typeof data.presentations !== "object" || data.presentations === null || typeof data.effects !== "object" || data.effects === null ||
      !Array.isArray(data.processedTurnIds) || typeof data.processedTurnDigests !== "object" || data.processedTurnDigests === null || !Array.isArray(data.callerMessages) ||
      (data.knowledgeAnswers !== undefined && !Array.isArray(data.knowledgeAnswers)) ||
      (data.availabilityReads !== undefined && !Array.isArray(data.availabilityReads)) ||
      (data.appointmentReads !== undefined && !Array.isArray(data.appointmentReads)) ||
      (data.terminal !== undefined && (data.lifecycle !== "ended" || typeof data.terminal !== "object" || data.terminal === null ||
        !CALL_TERMINAL_REASONS.includes((data.terminal as { reason: typeof CALL_TERMINAL_REASONS[number] }).reason) ||
        typeof (data.terminal as { at?: unknown }).at !== "string" || !Number.isFinite(Date.parse((data.terminal as { at: string }).at)))) ||
      (data.lifecycle === "starting" && (typeof data.admission !== "object" || data.admission === null))) return err({ kind: "storageCorrupt" });
  return ok({ ...(value as CallState), knowledgeAnswers: Array.isArray(data.knowledgeAnswers) ? data.knowledgeAnswers as CallState["knowledgeAnswers"] : [],
    availabilityReads: Array.isArray(data.availabilityReads) ? data.availabilityReads as CallState["availabilityReads"] : [],
    appointmentReads: Array.isArray(data.appointmentReads) ? data.appointmentReads as CallState["appointmentReads"] : [] });
}

function auditPayload(action: TransitionAction): Record<string, string> {
  switch (action.kind) {
    case "sessionActivated":
    case "sessionRenewed":
    case "sessionExpired":
    case "speechBegan": return { sessionId: action.sessionId };
    case "callEnded": return { sessionId: action.sessionId, reason: action.reason };
    case "admissionExpired": return {};
    case "callerTurn": return { turnId: action.turn.turnId, interpretation: action.interpretation.kind };
    case "presentationStarted":
    case "transferPossiblySent": return { presentationId: action.presentationId };
    case "presentationResolved": return { presentationId: action.presentationId, status: action.status };
    case "reconciliationDeadline": return { actionKey: action.actionKey };
    case "staffChangeRequested": return { taskKey: action.taskKey, actorRef: action.actorRef, operation: action.change.kind };
    case "staffAlertRequested": return { taskKey: action.taskKey, reason: action.reason };
    default: return { effectId: action.effectId };
  }
}

export class PostgresLedger implements LedgerStore {
  private readonly db: Kysely<Database>;
  private readonly clockForTests: ((suggestedAt: string) => string) | undefined;
  private readonly readiness: AutomationReadiness;

  constructor(db: Kysely<Database>, clockForTests?: (suggestedAt: string) => string, readiness: AutomationReadiness = unprovenReadiness) {
    this.db = db;
    this.clockForTests = clockForTests;
    this.readiness = readiness;
  }

  private async trustedNow(db: Kysely<Database>, suggestedAt: string): Promise<string> {
    if (this.clockForTests) return this.clockForTests(suggestedAt);
    const result = await sql<{ current_time: Date }>`select clock_timestamp() as current_time`.execute(db);
    const current = result.rows[0]?.current_time;
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new Error("database clock unavailable");
    return current.toISOString();
  }

  private stopIds(scope: LocationScope) {
    return { tenant_id: scope.tenantId as ClinicWriteStopTenantId, clinic_id: scope.clinicId as ClinicWriteStopClinicId };
  }

  private async stopStatus(db: Kysely<Database>, scope: LocationScope, afterEffectId?: string): Promise<Result<WriteStopStatus, TransitionFailure>> {
    const ids = this.stopIds(scope);
    const row = await db.selectFrom("clinic_write_stop").select(["version", "stopped", "actor_ref", "reason", "changed_at"])
      .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).executeTakeFirst();
    if (!row || row.version === 0) return ok({ stopped: false, version: "0", inFlight: [] });
    if (!Number.isSafeInteger(row.version) || row.version < 1 || !row.actor_ref || !row.reason ||
        !(row.changed_at instanceof Date) || !Number.isFinite(row.changed_at.getTime())) return err({ kind: "storageCorrupt" });
    let query = db.selectFrom("clinic_write_stop_inflight").select(["effect_id", "call_id", "action_key", "status"])
      .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id)
      .where("stop_version", "=", row.version as ClinicWriteStopEventsVersion);
    if (afterEffectId) query = query.where("effect_id", ">", afterEffectId as ClinicWriteStopInflightEffectId);
    const rows = row.stopped ? await query.orderBy("effect_id").limit(50).execute() : [];
    if (rows.some(item => !item.effect_id || !item.call_id || !item.action_key || (item.status !== "possiblySent" && item.status !== "uncertain"))) return err({ kind: "storageCorrupt" });
    return ok({ stopped: row.stopped, version: String(row.version), actorRef: row.actor_ref, reason: row.reason, changedAt: row.changed_at.toISOString(),
      inFlight: rows.map(item => ({ effectId: item.effect_id, callId: item.call_id, actionKey: item.action_key,
        status: item.status as "possiblySent" | "uncertain" })),
      ...(rows.length === 50 ? { nextAfterEffectId: rows[49]!.effect_id } : {}) });
  }

  async readWriteStop(scope: LocationScope, afterEffectId?: string): Promise<Result<WriteStopStatus, TransitionFailure>> {
    if (!scope.tenantId || !scope.clinicId || (afterEffectId !== undefined && (!afterEffectId || afterEffectId.length > 512))) return err({ kind: "invalidTransition" });
    try { return await this.stopStatus(this.db, scope, afterEffectId); }
    catch { return err({ kind: "storageFailure" }); }
  }

  async listWriteStopChanges(scope: LocationScope, afterVersion?: number): Promise<Result<WriteStopAuditPage, TransitionFailure>> {
    if (!scope.tenantId || !scope.clinicId || (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0))) return err({ kind: "invalidTransition" });
    try {
      const ids = this.stopIds(scope);
      const rows = await this.db.selectFrom("clinic_write_stop_events").select(["version", "stopped", "actor_ref", "reason", "changed_at"])
        .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id)
        .where("version", ">", (afterVersion ?? 0) as ClinicWriteStopEventsVersion)
        .orderBy("version").limit(50).execute();
      if (rows.some(row => !row.actor_ref || !row.reason || !(row.changed_at instanceof Date) || !Number.isFinite(row.changed_at.getTime()))) return err({ kind: "storageCorrupt" });
      const entries = rows.map(row => ({ version: String(row.version), stopped: row.stopped, actorRef: row.actor_ref,
        reason: row.reason, changedAt: row.changed_at.toISOString() }));
      return ok({ entries, ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async stopWrites(scope: LocationScope, actorRef: string, reason: string): Promise<Result<WriteStopStatus, TransitionFailure>> {
    if (!scope.tenantId || !scope.clinicId || !actorRef.trim() || actorRef.length > 256 || !reason.trim() || reason.length > 1_000) return err({ kind: "invalidTransition" });
    try {
      return await this.db.transaction().execute(async trx => {
        const ids = this.stopIds(scope);
        await trx.insertInto("clinic_write_stop").values({ ...ids, version: 0, stopped: false, actor_ref: null, reason: null, changed_at: null })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id"]).doNothing()).execute();
        const current = await trx.selectFrom("clinic_write_stop").select(["version", "stopped"])
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).forUpdate().executeTakeFirstOrThrow();
        if (!current.stopped) {
          const version = current.version + 1;
          const changed = await trx.updateTable("clinic_write_stop").set({ version, stopped: true, actor_ref: actorRef, reason,
            changed_at: sql`clock_timestamp()` })
            .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).returning("changed_at").executeTakeFirstOrThrow();
          if (!(changed.changed_at instanceof Date)) throw new Error("write stop clock unavailable");
          await trx.insertInto("clinic_write_stop_events").values({ ...ids, version: version as ClinicWriteStopEventsVersion,
            stopped: true, actor_ref: actorRef, reason, changed_at: changed.changed_at }).execute();
          await sql`insert into clinic_write_stop_inflight (tenant_id, clinic_id, stop_version, effect_id, call_id, action_key, status)
            select calls.tenant_id, calls.clinic_id, ${version}, effect_outbox.effect_id, effect_outbox.call_id,
              coalesce(nullif(effect_outbox.payload->>'actionKey', ''), 'unknown'), effect_outbox.status
            from effect_outbox join calls on calls.call_id = effect_outbox.call_id
            where calls.tenant_id = ${scope.tenantId} and calls.clinic_id = ${scope.clinicId}
              and effect_outbox.tenant_id = calls.tenant_id and effect_outbox.kind = 'hostWrite'
              and effect_outbox.status in ('possiblySent', 'uncertain')`.execute(trx);
        }
        const status = await this.stopStatus(trx, scope);
        if (!status.ok) throw new Error("write stop status corrupt");
        return status;
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async resumeWrites(scope: LocationScope, expectedVersion: string, actorRef: string, reason: string): Promise<Result<WriteStopStatus, WriteStopFailure>> {
    if (!scope.tenantId || !scope.clinicId || !actorRef.trim() || actorRef.length > 256 || !reason.trim() || reason.length > 1_000) return err({ kind: "invalidTransition" });
    const initial = await this.readWriteStop(scope);
    if (!initial.ok) return initial;
    if (initial.value.version !== expectedVersion) return err({ kind: "versionConflict" });
    if (!initial.value.stopped) return err({ kind: "invalidTransition" });
    try {
      const ready = await this.readiness(scope);
      if (!ready.ok) return ready;
      if (ready.value !== true) return err({ kind: "readinessFailed", missing: READINESS_REQUIREMENTS });
    } catch { return err({ kind: "readinessFailed", missing: READINESS_REQUIREMENTS }); }
    try {
      return await this.db.transaction().execute(async trx => {
        const ids = this.stopIds(scope);
        const current = await trx.selectFrom("clinic_write_stop").select(["version", "stopped"])
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).forUpdate().executeTakeFirst();
        if (!current || String(current.version) !== expectedVersion) return err({ kind: "versionConflict" });
        if (!current.stopped) return err({ kind: "invalidTransition" });
        const version = current.version + 1;
        const changed = await trx.updateTable("clinic_write_stop").set({ version, stopped: false, actor_ref: actorRef, reason,
          changed_at: sql`clock_timestamp()` })
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).returning("changed_at").executeTakeFirstOrThrow();
        if (!(changed.changed_at instanceof Date)) throw new Error("write resume clock unavailable");
        await trx.insertInto("clinic_write_stop_events").values({ ...ids, version: version as ClinicWriteStopEventsVersion,
          stopped: false, actor_ref: actorRef, reason, changed_at: changed.changed_at }).execute();
        const status = await this.stopStatus(trx, scope);
        if (!status.ok) throw new Error("write resume status corrupt");
        return status;
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async start(callId: string, policy: CallPolicy): Promise<Result<CallState, TransitionFailure>> {
    if (!callId) return err({ kind: "invalidTransition" });
    const state = initialState(callId, policy);
    try {
      const inserted = await this.db.insertInto("calls").values({
        call_id: callId as CallsCallId,
        tenant_id: policy.scope.tenantId,
        clinic_id: policy.scope.clinicId,
        location_id: policy.scope.locationId,
        version: 0,
        policy_version: policy.policyVersion,
        state,
      }).onConflict(conflict => conflict.column("call_id").doNothing()).returning("call_id").executeTakeFirst();
      return inserted ? ok(state) : err({ kind: "invalidTransition" });
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async findAdmission(callId: string): Promise<Result<AdmissionReceipt | null, TransitionFailure>> {
    try {
      const row = await this.db.selectFrom("calls").select("state").where("call_id", "=", callId as CallsCallId).executeTakeFirst();
      if (!row) return ok(null);
      const decoded = decodeState(row.state, callId);
      return decoded.ok ? ok(admissionReceipt(decoded.value)) : decoded;
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async findExpiredAdmissions(now: string, scope?: LocationScope): Promise<Result<readonly AdmissionReceipt[], TransitionFailure>> {
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    try {
      const ledgerNow = await this.trustedNow(this.db, now);
      let query = this.db.selectFrom("calls").select(["call_id", "state"])
        .where(sql<boolean>`state->>'lifecycle' = 'starting'`)
        .where(sql<boolean>`(state->'admission'->>'deadline')::timestamptz <= ${ledgerNow}::timestamptz`);
      if (scope) query = query.where("tenant_id", "=", scope.tenantId).where("clinic_id", "=", scope.clinicId).where("location_id", "=", scope.locationId);
      const rows = await query.limit(100).execute();
      const receipts: AdmissionReceipt[] = [];
      for (const row of rows) {
        const decoded = decodeState(row.state, row.call_id);
        if (!decoded.ok) return decoded;
        const receipt = admissionReceipt(decoded.value);
        if (!receipt) return err({ kind: "storageCorrupt" });
        receipts.push(receipt);
      }
      return ok(receipts);
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async findExpiredSessions(now: string, scope?: LocationScope): Promise<Result<readonly ActiveSessionReceipt[], TransitionFailure>> {
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    try {
      const ledgerNow = await this.trustedNow(this.db, now);
      let query = this.db.selectFrom("calls").select(["call_id", "state"])
        .where(sql<boolean>`state->>'lifecycle' = 'active'`)
        .where(sql<boolean>`(state->'sessionLease'->>'expiresAt')::timestamptz <= ${ledgerNow}::timestamptz`);
      if (scope) query = query.where("tenant_id", "=", scope.tenantId).where("clinic_id", "=", scope.clinicId).where("location_id", "=", scope.locationId);
      const rows = await query.limit(100).execute();
      const receipts: ActiveSessionReceipt[] = [];
      for (const row of rows) {
        const decoded = decodeState(row.state, row.call_id);
        if (!decoded.ok) return decoded;
        if (!decoded.value.sessionLease) return err({ kind: "storageCorrupt" });
        receipts.push({ callId: row.call_id, scope: decoded.value.policy.scope, lease: decoded.value.sessionLease });
      }
      return ok(receipts);
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async findPendingPresentations(now: string, scope?: LocationScope, afterCallId?: string): Promise<Result<readonly PendingPresentationRef[], TransitionFailure>> {
    if (!Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    try {
      const ledgerNow = await this.trustedNow(this.db, now);
      let query = this.db.selectFrom("calls").select(["call_id", "state"])
        .where(sql<boolean>`state->>'lifecycle' = 'active'`)
        .where(sql<boolean>`state->'admission' is not null`)
        .where(sql<boolean>`state->>'pendingPresentationId' is not null`)
        .where(sql<boolean>`(state->'sessionLease'->>'expiresAt')::timestamptz > ${ledgerNow}::timestamptz`);
      if (scope) query = query.where("tenant_id", "=", scope.tenantId).where("clinic_id", "=", scope.clinicId).where("location_id", "=", scope.locationId);
      if (afterCallId) query = query.where("call_id", ">", afterCallId as CallsCallId);
      const rows = await query.orderBy("call_id").limit(100).execute();
      const refs: PendingPresentationRef[] = [];
      for (const row of rows) {
        const decoded = decodeState(row.state, row.call_id);
        if (!decoded.ok) return decoded;
        const state = decoded.value;
        const presentationId = state.pendingPresentationId;
        if (!state.admission || !state.sessionLease || !presentationId || state.presentations[presentationId]?.status !== "pending") return err({ kind: "storageCorrupt" });
        refs.push({ callId: state.callId, scope: structuredClone(state.policy.scope), sessionId: state.sessionLease.sessionId, presentationId });
      }
      return ok(refs);
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async findRecoverableEffects(now: string, scope?: LocationScope, afterEffectId?: string): Promise<Result<readonly RecoverableEffectRef[], TransitionFailure>> {
    if (!Number.isFinite(Date.parse(now)) || (afterEffectId !== undefined && (!afterEffectId || afterEffectId.length > 512))) return err({ kind: "invalidTransition" });
    try {
      const ledgerNow = await this.trustedNow(this.db, now);
      const dueBefore = new Date(Date.parse(ledgerNow) - POSSIBLE_SEND_RECOVERY_DELAY_MS).toISOString();
      let query = this.db.selectFrom("effect_outbox").innerJoin("calls", "calls.call_id", "effect_outbox.call_id")
        .select(["effect_outbox.effect_id", "effect_outbox.call_id", "effect_outbox.kind", "effect_outbox.status", "effect_outbox.payload",
          "calls.tenant_id", "calls.clinic_id", "calls.location_id"])
        .whereRef("effect_outbox.tenant_id", "=", "calls.tenant_id")
        .where(sql<boolean>`(effect_outbox.status = 'pending' or
          (effect_outbox.status = 'possiblySent' and (effect_outbox.payload->>'possiblySentAt')::timestamptz <= ${dueBefore}::timestamptz))`);
      if (scope) query = query.where("calls.tenant_id", "=", scope.tenantId).where("calls.clinic_id", "=", scope.clinicId).where("calls.location_id", "=", scope.locationId);
      if (afterEffectId) query = query.where("effect_outbox.effect_id", ">", afterEffectId as EffectOutboxEffectId);
      const rows = await query.orderBy("effect_outbox.effect_id").limit(100).execute();
      const refs: RecoverableEffectRef[] = [];
      for (const row of rows) {
        const payload = row.payload as Record<string, unknown>;
        if (!payload || typeof payload !== "object" || payload.id !== row.effect_id || payload.kind !== row.kind || payload.status !== row.status ||
            !(["hostWrite", "hostReconcile", "staffTask", "staffReconcile", "staffChange", "staffChangeReconcile", "operatorAlert", "operatorAlertReconcile"] as readonly string[]).includes(row.kind) ||
            (row.status !== "pending" && row.status !== "possiblySent") ||
            (row.status === "possiblySent" && row.kind !== "hostWrite" && row.kind !== "staffTask" && row.kind !== "staffChange" && row.kind !== "operatorAlert") ||
            (row.status === "possiblySent" && (typeof payload.possiblySentAt !== "string" || !Number.isFinite(Date.parse(payload.possiblySentAt))))) return err({ kind: "storageCorrupt" });
        refs.push({ callId: row.call_id, scope: { tenantId: row.tenant_id, clinicId: row.clinic_id, locationId: row.location_id },
          effectId: row.effect_id, kind: row.kind as Effect["kind"], status: row.status });
      }
      return ok(refs);
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async admit(callId: string, policy: CallPolicy, admission: Admission): Promise<Result<AdmissionResult, TransitionFailure>> {
    if (!callId || !admission.key.accountRef || !admission.key.providerCallRef || !admission.dialedNumber ||
        !Number.isFinite(Date.parse(admission.acceptedAt)) || Date.parse(admission.deadline) <= Date.parse(admission.acceptedAt)) return err({ kind: "invalidTransition" });
    try {
      return await this.db.transaction().execute(async trx => {
        const acceptedAt = await this.trustedNow(trx, admission.acceptedAt);
        const storedAdmission: Admission = { ...admission, acceptedAt, deadline: new Date(Date.parse(acceptedAt) + 30_000).toISOString() };
        const state = initialState(callId, policy);
        state.lifecycle = "starting";
        state.admission = storedAdmission;
        const inserted = await trx.insertInto("calls").values({
          call_id: callId as CallsCallId,
          tenant_id: policy.scope.tenantId,
          clinic_id: policy.scope.clinicId,
          location_id: policy.scope.locationId,
          version: 0,
          policy_version: policy.policyVersion,
          state,
        }).onConflict(conflict => conflict.column("call_id").doNothing()).returning("call_id").executeTakeFirst();
        if (inserted) {
          await trx.insertInto("call_events").values({
            call_id: callId as CallsCallId,
            tenant_id: policy.scope.tenantId,
            sequence: 0 as CallEventsSequence,
            kind: "callAdmitted",
            payload: { accountRef: admission.key.accountRef, providerCallRef: admission.key.providerCallRef, dialedNumber: admission.dialedNumber },
          }).execute();
          return ok({ kind: "created", receipt: admissionReceipt(state)! });
        }
        const row = await trx.selectFrom("calls").select("state").where("call_id", "=", callId as CallsCallId).executeTakeFirstOrThrow();
        const decoded = decodeState(row.state, callId);
        if (!decoded.ok) return decoded;
        const receipt = admissionReceipt(decoded.value);
        return receipt && sameAdmission(receipt.admission, storedAdmission)
          ? ok({ kind: "duplicate", receipt }) : err({ kind: "callConflict" });
      });
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async read(callId: string, scope: LocationScope): Promise<Result<CallState, TransitionFailure>> {
    try {
      const row = await this.db.selectFrom("calls").select(["state", "version"])
        .where("call_id", "=", callId as CallsCallId)
        .where("tenant_id", "=", scope.tenantId)
        .where("clinic_id", "=", scope.clinicId)
        .where("location_id", "=", scope.locationId)
        .executeTakeFirst();
      if (!row) return err({ kind: "callUnknown" });
      const decoded = decodeState(row.state, callId);
      if (!decoded.ok) return decoded;
      if (decoded.value.version !== row.version) return err({ kind: "storageCorrupt" });
      return ok(structuredClone(decoded.value));
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async listCalls(scope: LocationScope, afterCallId?: string): Promise<Result<readonly CallState[], TransitionFailure>> {
    if (afterCallId !== undefined && (!afterCallId || afterCallId.length > 256)) return err({ kind: "invalidTransition" });
    try {
      let query = this.db.selectFrom("calls").select(["call_id", "version", "state"])
        .where("tenant_id", "=", scope.tenantId).where("clinic_id", "=", scope.clinicId).where("location_id", "=", scope.locationId);
      if (afterCallId) query = query.where("call_id", ">", afterCallId as CallsCallId);
      const rows = await query.orderBy("call_id").limit(100).execute();
      const calls: CallState[] = [];
      for (const row of rows) {
        const decoded = decodeState(row.state, row.call_id);
        if (!decoded.ok || decoded.value.version !== row.version || !decoded.value.policy?.scope ||
            decoded.value.policy.scope.tenantId !== scope.tenantId || decoded.value.policy.scope.clinicId !== scope.clinicId ||
            decoded.value.policy.scope.locationId !== scope.locationId) return err({ kind: "storageCorrupt" });
        calls.push(decoded.value);
      }
      return ok(calls);
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async listStaffItems(scope: LocationScope, afterTaskKey?: string): Promise<Result<readonly StaffQueueEntry[], TransitionFailure>> {
    if (afterTaskKey !== undefined && (!afterTaskKey || afterTaskKey.length > 256)) return err({ kind: "invalidTransition" });
    try {
      let query = this.db.selectFrom("staff_items").innerJoin("calls", "calls.call_id", "staff_items.call_id")
        .select(["staff_items.task_key", "staff_items.call_id", "staff_items.status", "staff_items.payload", "calls.version"])
        .where("staff_items.tenant_id", "=", scope.tenantId)
        .where("calls.tenant_id", "=", scope.tenantId)
        .where("calls.clinic_id", "=", scope.clinicId)
        .where("calls.location_id", "=", scope.locationId);
      if (afterTaskKey) query = query.where("staff_items.task_key", ">", afterTaskKey as StaffItemsTaskKey);
      const rows = await query.orderBy("staff_items.task_key").limit(50).execute();
      const entries: StaffQueueEntry[] = [];
      for (const row of rows) {
        const item = row.payload as StaffItem;
        if (!item || item.key !== row.task_key || item.status !== row.status || !item.scope ||
            item.scope.tenantId !== scope.tenantId || item.scope.clinicId !== scope.clinicId || item.scope.locationId !== scope.locationId ||
            typeof item.dueAt !== "string" || !Number.isFinite(Date.parse(item.dueAt)) || !item.destination ||
            typeof item.reason !== "string") return err({ kind: "storageCorrupt" });
        entries.push({ callId: row.call_id, callVersion: row.version, taskKey: item.key, reason: item.reason, status: item.status, dueAt: item.dueAt,
          destination: structuredClone(item.destination), ...(item.linkedActionKey === undefined ? {} : { linkedActionKey: item.linkedActionKey }),
          ...(item.pendingChangeKey === undefined ? {} : { pendingChangeKey: item.pendingChangeKey }),
          ...(item.reviewRequired === undefined ? {} : { reviewRequired: item.reviewRequired }),
          ...(item.alerts === undefined ? {} : { alerts: structuredClone(item.alerts) }) });
      }
      return ok(entries);
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async apply(callId: string, scope: LocationScope, expectedVersion: number, action: TransitionAction): Promise<Result<CallState, TransitionFailure>> {
    try {
      return await this.db.transaction().execute(async trx => {
        const row = await trx.selectFrom("calls").select(["state", "version"])
          .where("call_id", "=", callId as CallsCallId)
          .where("tenant_id", "=", scope.tenantId)
          .where("clinic_id", "=", scope.clinicId)
          .where("location_id", "=", scope.locationId)
          .forUpdate().executeTakeFirst();
        if (!row) return err({ kind: "callUnknown" });
        if (row.version !== expectedVersion) return err({ kind: "versionConflict" });
        const decoded = decodeState(row.state, callId);
        if (!decoded.ok || decoded.value.version !== row.version) return err({ kind: "storageCorrupt" });
        let effectiveAction = action;
        if (action.kind === "markHostPossiblySent") {
          const ids = this.stopIds(scope);
          await trx.insertInto("clinic_write_stop").values({ ...ids, version: 0, stopped: false, actor_ref: null, reason: null, changed_at: null })
            .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id"]).doNothing()).execute();
          const stop = await trx.selectFrom("clinic_write_stop").select("stopped")
            .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).forShare().executeTakeFirstOrThrow();
          if (stop.stopped) effectiveAction = { kind: "hostWriteBlocked", effectId: action.effectId, now: action.now };
        }
        const trustedAction = decoded.value.admission && "now" in effectiveAction && effectiveAction.now !== undefined
          ? { ...effectiveAction, now: await this.trustedNow(trx, effectiveAction.now) } as TransitionAction : effectiveAction;
        const result = transition(decoded.value, trustedAction);
        if (!result.ok) return result;
        const next = result.value;
        if (next.version === row.version) return ok(structuredClone(next));

        await trx.updateTable("calls").set({ version: next.version, state: next })
          .where("call_id", "=", callId as CallsCallId).execute();
        await trx.insertInto("call_events").values({
          call_id: callId as CallsCallId,
          tenant_id: scope.tenantId,
          sequence: next.version as CallEventsSequence,
          kind: trustedAction.kind,
          payload: auditPayload(trustedAction),
        }).execute();

        for (const [id, effect] of Object.entries(next.effects)) {
          const previous = decoded.value.effects[id];
          if (JSON.stringify(effect) === JSON.stringify(previous)) continue;
          if (!previous) {
            await trx.insertInto("effect_outbox").values({
              effect_id: id as EffectOutboxEffectId,
              call_id: callId as CallsCallId,
              tenant_id: scope.tenantId,
              kind: effect.kind,
              status: effect.status,
              payload: effect,
            }).execute();
          } else {
            const updated = await trx.updateTable("effect_outbox").set({ status: effect.status, payload: effect })
              .where("effect_id", "=", id as EffectOutboxEffectId)
              .where("call_id", "=", callId as CallsCallId)
              .where("tenant_id", "=", scope.tenantId).executeTakeFirst();
            if (updated.numUpdatedRows !== 1n) throw new Error("outbox ownership mismatch");
          }
        }

        for (const [key, item] of Object.entries(next.staffItems)) {
          const previous = decoded.value.staffItems[key];
          if (JSON.stringify(item) === JSON.stringify(previous)) continue;
          if (!previous) {
            await trx.insertInto("staff_items").values({
              task_key: key as StaffItemsTaskKey,
              call_id: callId as CallsCallId,
              tenant_id: scope.tenantId,
              status: item.status,
              payload: item,
            }).execute();
          } else {
            const updated = await trx.updateTable("staff_items").set({ status: item.status, payload: item })
              .where("task_key", "=", key as StaffItemsTaskKey)
              .where("call_id", "=", callId as CallsCallId)
              .where("tenant_id", "=", scope.tenantId).executeTakeFirst();
            if (updated.numUpdatedRows !== 1n) throw new Error("staff item ownership mismatch");
          }
        }

        return ok(structuredClone(next));
      });
    } catch {
      return err({ kind: "storageFailure" });
    }
  }
}
