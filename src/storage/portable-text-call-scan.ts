import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { CallState, Result } from "../core/model.ts";
import type Database from "./generated/Database.ts";
import type { CallsCallId } from "./generated/public/Calls.ts";
import { isStoredStandaloneTextEvent, isStoredStandaloneTextState } from "./standalone-call-state.ts";

export type PortableTextCallScan = Readonly<{ count: number; locationKeys: ReadonlySet<string>;
  countsByLocation: ReadonlyMap<string, number> }>;
export type PortableTextCallScanFailure = Readonly<{
  kind: "callsRequireRetention" | "unresolvedWork" | "storageFailure";
}>;

const pageSize = 500;

/** Validate every retained call and event before excluding their per-call records from an archive. */
export async function scanPortableTextCalls(db: Kysely<Database>, tenantId: string):
  Promise<Result<PortableTextCallScan, PortableTextCallScanFailure>> {
  try {
    const side = await sql<{ effects: boolean; staff: boolean; leases: boolean }>`select
      exists(select 1 from effect_outbox where tenant_id = ${tenantId}) as effects,
      exists(select 1 from staff_items where tenant_id = ${tenantId}) as staff,
      exists(select 1 from effect_call_leases join calls using (call_id)
        where calls.tenant_id = ${tenantId}) as leases`.execute(db);
    if (!side.rows[0] || side.rows[0].effects || side.rows[0].staff || side.rows[0].leases) {
      return err({ kind: "unresolvedWork" });
    }
    const locationKeys = new Set<string>();
    const countsByLocation = new Map<string, number>();
    let count = 0;
    let afterCallId: CallsCallId | undefined;
    while (true) {
      let calls = db.selectFrom("calls").select(["call_id", "tenant_id", "clinic_id", "location_id",
        "version", "policy_version", "state"]).where("tenant_id", "=", tenantId);
      if (afterCallId) calls = calls.where("call_id", ">", afterCallId);
      const rows = await calls.orderBy("call_id").limit(pageSize).execute();
      if (!rows.length) break;
      const versions = new Map<string, { expected: number; seen: number; lastKind: string | null }>();
      for (const row of rows) {
        const state = row.state as CallState;
        if (!isStoredStandaloneTextState(state) || state.lifecycle !== "ended" ||
            state.terminal?.reason !== "textCompleted" || state.version < 1 ||
            state.callId !== row.call_id || state.version !== row.version ||
            state.policy.policyVersion !== row.policy_version ||
            state.policy.scope.tenantId !== row.tenant_id ||
            state.policy.scope.clinicId !== row.clinic_id ||
            state.policy.scope.locationId !== row.location_id) return err({ kind: "callsRequireRetention" });
        versions.set(row.call_id, { expected: row.version, seen: 0, lastKind: null });
        const locationKey = JSON.stringify([row.clinic_id, row.location_id]);
        locationKeys.add(locationKey);
        countsByLocation.set(locationKey, (countsByLocation.get(locationKey) ?? 0) + 1);
        count += 1;
        if (!Number.isSafeInteger(count) || !Number.isSafeInteger(countsByLocation.get(locationKey))) {
          return err({ kind: "callsRequireRetention" });
        }
      }
      const callIds = rows.map(row => row.call_id);
      let afterEvent: Readonly<{ callId: string; sequence: number }> | undefined;
      while (true) {
        let events = db.selectFrom("call_events").select(["call_id", "tenant_id", "sequence", "kind", "payload"])
          .where("call_id", "in", callIds);
        if (afterEvent) events = events.where(sql<boolean>`(call_id, sequence) >
          (${afterEvent.callId}, ${afterEvent.sequence})`);
        const eventRows = await events.orderBy("call_id").orderBy("sequence").limit(pageSize).execute();
        if (!eventRows.length) break;
        for (const event of eventRows) {
          const position = versions.get(event.call_id);
          if (!position || event.tenant_id !== tenantId || event.sequence !== position.seen + 1 ||
              !isStoredStandaloneTextEvent(event.kind, event.payload)) return err({ kind: "callsRequireRetention" });
          position.seen += 1;
          position.lastKind = event.kind;
        }
        const last = eventRows.at(-1)!;
        afterEvent = { callId: last.call_id, sequence: last.sequence };
        if (eventRows.length < pageSize) break;
      }
      if ([...versions.values()].some(position => position.seen !== position.expected ||
          position.lastKind !== "textPresentationWritten")) return err({ kind: "callsRequireRetention" });
      afterCallId = rows.at(-1)!.call_id;
      if (rows.length < pageSize) break;
    }
    return ok({ count, locationKeys, countsByLocation });
  } catch {
    return err({ kind: "storageFailure" });
  }
}
