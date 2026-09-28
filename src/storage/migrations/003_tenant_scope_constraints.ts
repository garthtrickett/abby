import { sql } from "kysely";
import type { Kysely } from "kysely";

// Existing inconsistent rows cause this migration to fail. They must be
// investigated, never silently reassigned to another tenant.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("calls")
    .addUniqueConstraint("calls_call_tenant_unique", ["call_id", "tenant_id"]).execute();
  await sql`alter table calls add constraint calls_state_scope_check check (
    coalesce(jsonb_typeof(state) = 'object', false)
    and coalesce(state->>'callId' = call_id, false)
    and coalesce(jsonb_typeof(state->'version') = 'number', false)
    and coalesce(state->>'version' = version::text, false)
    and coalesce(state->'policy'->>'policyVersion' = policy_version, false)
    and coalesce(state->'policy'->'scope'->>'tenantId' = tenant_id, false)
    and coalesce(state->'policy'->'scope'->>'clinicId' = clinic_id, false)
    and coalesce(state->'policy'->'scope'->>'locationId' = location_id, false)
  )`.execute(db);
  await sql`alter table clinic_settings add constraint clinic_settings_policy_scope_check check (
    coalesce(jsonb_typeof(policy) = 'object', false)
    and coalesce(policy->>'policyVersion' = version::text, false)
    and coalesce(policy->'scope'->>'tenantId' = tenant_id, false)
    and coalesce(policy->'scope'->>'clinicId' = clinic_id, false)
    and coalesce(policy->'scope'->>'locationId' = location_id, false)
  )`.execute(db);
  await db.schema.alterTable("call_events")
    .addForeignKeyConstraint("call_events_call_tenant_fk", ["call_id", "tenant_id"], "calls", ["call_id", "tenant_id"],
      constraint => constraint.onDelete("cascade")).execute();
  await db.schema.alterTable("effect_outbox")
    .addForeignKeyConstraint("effect_outbox_call_tenant_fk", ["call_id", "tenant_id"], "calls", ["call_id", "tenant_id"],
      constraint => constraint.onDelete("cascade")).execute();
  await db.schema.alterTable("staff_items")
    .addForeignKeyConstraint("staff_items_call_tenant_fk", ["call_id", "tenant_id"], "calls", ["call_id", "tenant_id"],
      constraint => constraint.onDelete("cascade")).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("staff_items").dropConstraint("staff_items_call_tenant_fk").execute();
  await db.schema.alterTable("effect_outbox").dropConstraint("effect_outbox_call_tenant_fk").execute();
  await db.schema.alterTable("call_events").dropConstraint("call_events_call_tenant_fk").execute();
  await db.schema.alterTable("clinic_settings").dropConstraint("clinic_settings_policy_scope_check").execute();
  await db.schema.alterTable("calls").dropConstraint("calls_state_scope_check").execute();
  await db.schema.alterTable("calls").dropConstraint("calls_call_tenant_unique").execute();
}
