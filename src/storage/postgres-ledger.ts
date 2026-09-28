import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { ActiveSessionReceipt, Admission, AdmissionReceipt, AdmissionResult, CallPolicy, CallState, LocationScope, Result, TransitionAction, TransitionFailure } from "../core/model.ts";
import { admissionReceipt, initialState, sameAdmission } from "../core/ledger.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { transition } from "../core/transition.ts";
import type Database from "./generated/Database.ts";
import type { CallsCallId } from "./generated/public/Calls.ts";
import type { CallEventsSequence } from "./generated/public/CallEvents.ts";
import type { EffectOutboxEffectId } from "./generated/public/EffectOutbox.ts";
import type { StaffItemsTaskKey } from "./generated/public/StaffItems.ts";

function decodeState(value: unknown, callId: string): Result<CallState, TransitionFailure> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return err({ kind: "storageCorrupt" });
  const data = value as Record<string, unknown>;
  if (data.callId !== callId || !Number.isInteger(data.version) || !["starting", "active", "ended"].includes(String(data.lifecycle)) || typeof data.policy !== "object" || data.policy === null ||
      typeof data.actions !== "object" || data.actions === null || typeof data.effects !== "object" || data.effects === null ||
      !Array.isArray(data.processedTurnIds) || typeof data.processedTurnDigests !== "object" || data.processedTurnDigests === null || !Array.isArray(data.callerMessages) ||
      (data.lifecycle === "starting" && (typeof data.admission !== "object" || data.admission === null))) return err({ kind: "storageCorrupt" });
  return ok(value as CallState);
}

function auditPayload(action: TransitionAction): Record<string, string> {
  switch (action.kind) {
    case "sessionActivated":
    case "sessionRenewed":
    case "sessionExpired":
    case "callEnded":
    case "speechBegan": return { sessionId: action.sessionId };
    case "admissionExpired": return {};
    case "callerTurn": return { turnId: action.turn.turnId, interpretation: action.interpretation.kind };
    case "presentationStarted":
    case "transferPossiblySent":
    case "presentationResolved": return { presentationId: action.presentationId };
    case "reconciliationDeadline": return { actionKey: action.actionKey };
    default: return { effectId: action.effectId };
  }
}

export class PostgresLedger implements LedgerStore {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
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
      let query = this.db.selectFrom("calls").select(["call_id", "state"])
        .where(sql<boolean>`state->>'lifecycle' = 'starting'`)
        .where(sql<boolean>`(state->'admission'->>'deadline')::timestamptz <= ${now}::timestamptz`);
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
      let query = this.db.selectFrom("calls").select(["call_id", "state"])
        .where(sql<boolean>`state->>'lifecycle' = 'active'`)
        .where(sql<boolean>`(state->'sessionLease'->>'expiresAt')::timestamptz <= ${now}::timestamptz`);
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

  async admit(callId: string, policy: CallPolicy, admission: Admission): Promise<Result<AdmissionResult, TransitionFailure>> {
    if (!callId || !admission.key.accountRef || !admission.key.providerCallRef || !admission.dialedNumber ||
        !Number.isFinite(Date.parse(admission.acceptedAt)) || Date.parse(admission.deadline) <= Date.parse(admission.acceptedAt)) return err({ kind: "invalidTransition" });
    const state = initialState(callId, policy);
    state.lifecycle = "starting";
    state.admission = structuredClone(admission);
    try {
      return await this.db.transaction().execute(async trx => {
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
        return receipt && sameAdmission(receipt.admission, admission)
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
        const result = transition(decoded.value, action);
        if (!result.ok) return result;
        const next = result.value;
        if (next.version === row.version) return ok(structuredClone(next));

        await trx.updateTable("calls").set({ version: next.version, state: next })
          .where("call_id", "=", callId as CallsCallId).execute();
        await trx.insertInto("call_events").values({
          call_id: callId as CallsCallId,
          tenant_id: scope.tenantId,
          sequence: next.version as CallEventsSequence,
          kind: action.kind,
          payload: auditPayload(action),
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
