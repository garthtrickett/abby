import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { CallState, Result } from "../core/model.ts";
import type Database from "./generated/Database.ts";
import { isStoredStandalonePolicy } from "./postgres-policy-store.ts";
import { isStoredStandaloneTextEvent, isStoredStandaloneTextState } from "./standalone-call-state.ts";

export type StandalonePrivacyArea = "calls" | "callEvents" | "settings" | "effectOutbox" | "staffItems" |
  "pendingLocation" | "knowledge" | "voiceLeases" | "inflightWrites";
export type StandalonePrivacyPreflightFailure =
  | Readonly<{ kind: "unsafeExistingData"; areas: readonly StandalonePrivacyArea[] }>
  | Readonly<{ kind: "storageFailure" }>;

const maxRows = 10_000;

/** Point-in-time check for known rich/reference surfaces before a local standalone text probe. */
export async function checkStandaloneTextDatabase(db: Kysely<Database>):
  Promise<Result<true, StandalonePrivacyPreflightFailure>> {
  try {
    return await db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
      const areas = new Set<StandalonePrivacyArea>();
      const side = await sql<{
        effect_outbox: boolean; staff_items: boolean; pending_location: boolean;
        knowledge: boolean; voice_leases: boolean; inflight_writes: boolean;
      }>`select exists(select 1 from effect_outbox) as effect_outbox,
          exists(select 1 from staff_items) as staff_items,
          exists(select 1 from pending_location_calls) as pending_location,
          (exists(select 1 from clinic_knowledge_heads) or exists(select 1 from clinic_knowledge_events)) as knowledge,
          exists(select 1 from effect_call_leases) as voice_leases,
          exists(select 1 from clinic_write_stop_inflight) as inflight_writes`.execute(trx);
      const existing = side.rows[0];
      if (!existing) throw new Error("preflight query returned no row");
      if (existing.effect_outbox) areas.add("effectOutbox");
      if (existing.staff_items) areas.add("staffItems");
      if (existing.pending_location) areas.add("pendingLocation");
      if (existing.knowledge) areas.add("knowledge");
      if (existing.voice_leases) areas.add("voiceLeases");
      if (existing.inflight_writes) areas.add("inflightWrites");

      const calls = await trx.selectFrom("calls")
        .select(["call_id", "tenant_id", "clinic_id", "location_id", "version", "policy_version", "state"])
        .limit(maxRows + 1).execute();
      if (calls.length > maxRows) areas.add("calls");
      for (const row of calls) {
        try {
          const state = row.state as CallState;
          if (!isStoredStandaloneTextState(state) || state.callId !== row.call_id || state.version !== row.version ||
              state.policy.policyVersion !== row.policy_version || state.policy.scope.tenantId !== row.tenant_id ||
              state.policy.scope.clinicId !== row.clinic_id || state.policy.scope.locationId !== row.location_id) {
            areas.add("calls"); break;
          }
        } catch { areas.add("calls"); break; }
      }

      const events = await trx.selectFrom("call_events").select(["kind", "payload"]).limit(maxRows + 1).execute();
      if (events.length > maxRows || events.some(row => !isStoredStandaloneTextEvent(row.kind, row.payload))) areas.add("callEvents");

      const settings = await trx.selectFrom("clinic_settings")
        .select(["tenant_id", "clinic_id", "location_id", "version", "policy"]).limit(maxRows + 1).execute();
      if (settings.length > maxRows || settings.some(row => !isStoredStandalonePolicy(row.policy,
        { tenantId: row.tenant_id, clinicId: row.clinic_id, locationId: row.location_id }, row.version))) areas.add("settings");

      return areas.size > 0
        ? err({ kind: "unsafeExistingData", areas: [...areas].sort() })
        : ok(true);
    });
  } catch { return err({ kind: "storageFailure" }); }
}
