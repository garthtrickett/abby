import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type Database from "../generated/Database.ts";

/** Explicit compatibility with the shared budget's migrations020/048. This is
 * neither an account quota claim nor whole-database/clinic readiness. Changes
 * to these schemas require a reviewed contract update and requalification. */
const expected = [
  {
    "name": "cliniko_request_budgets",
    "schema": "public",
    "kind": "r",
    "columns": [
      {
        "name": "budget_ref",
        "type": "text",
        "default": null,
        "notNull": true
      },
      {
        "name": "sent_at_ms",
        "type": "jsonb",
        "default": "'[]'::jsonb",
        "notNull": true
      },
      {
        "name": "cooldown_until_ms",
        "type": "bigint",
        "default": "0",
        "notNull": true
      },
      {
        "name": "max_per_minute",
        "type": "integer",
        "default": null,
        "notNull": true
      }
    ],
    "constraints": [
      {
        "kind": "c",
        "name": "cliniko_request_budgets_check",
        "validated": true,
        "deferrable": false,
        "definition": "CHECK (((budget_ref ~ '^[0-9a-f]{64}$'::text) AND (jsonb_typeof(sent_at_ms) = 'array'::text) AND (cooldown_until_ms >= 0) AND ((max_per_minute >= 1) AND (max_per_minute <= 200))))"
      },
      {
        "kind": "p",
        "name": "cliniko_request_budgets_pkey",
        "validated": true,
        "deferrable": false,
        "definition": "PRIMARY KEY (budget_ref)"
      }
    ],
    "triggers": [
      {
        "name": "cliniko_request_budget_hold_guard",
        "enabled": "O",
        "definition": "CREATE TRIGGER cliniko_request_budget_hold_guard BEFORE INSERT OR UPDATE OF sent_at_ms, max_per_minute ON public.cliniko_request_budgets FOR EACH ROW EXECUTE FUNCTION cliniko_request_budget_hold_guard()",
        "securityDefiner": false,
        "functionLanguage": "plpgsql",
        "functionBodySha256": "447e723dba40a1f5d89ec1d1f928fc290b931e626fc78d17844173a44220004c"
      }
    ]
  },
  {
    "name": "cliniko_request_reservations",
    "schema": "public",
    "kind": "r",
    "columns": [
      {
        "name": "lease_ref",
        "type": "uuid",
        "default": null,
        "notNull": true
      },
      {
        "name": "budget_ref",
        "type": "text",
        "default": null,
        "notNull": true
      },
      {
        "name": "remaining",
        "type": "integer",
        "default": null,
        "notNull": true
      },
      {
        "name": "expires_at_ms",
        "type": "bigint",
        "default": null,
        "notNull": true
      }
    ],
    "constraints": [
      {
        "kind": "c",
        "name": "cliniko_request_reservations_bounds",
        "validated": true,
        "deferrable": false,
        "definition": "CHECK (((budget_ref ~ '^[0-9a-f]{64}$'::text) AND ((remaining >= 0) AND (remaining <= 200)) AND (expires_at_ms > 0)))"
      },
      {
        "kind": "f",
        "name": "cliniko_request_reservations_budget_ref_fkey",
        "validated": true,
        "deferrable": false,
        "definition": "FOREIGN KEY (budget_ref) REFERENCES cliniko_request_budgets(budget_ref) ON DELETE CASCADE"
      },
      {
        "kind": "p",
        "name": "cliniko_request_reservations_pkey",
        "validated": true,
        "deferrable": false,
        "definition": "PRIMARY KEY (lease_ref)"
      }
    ],
    "triggers": null
  }
] as const;

type Trigger = Readonly<{ functionBody: string | null; [key: string]: unknown }>;
type Schema = Readonly<{ name: string; schema: string; kind: string; columns: unknown; constraints: unknown; triggers: readonly Trigger[] | null }>;

/** One read-only catalog snapshot, resolving the same unqualified relations as
 * the SQL budget. Exact bounded metadata detects missing/incompatible columns,
 * defaults, constraints and the enabled legacy-worker hold guard. It reads no
 * account rows and creates no table, lease, claim, history or migration. */
export async function checkClinikoRequestBudgetSchema(db: Kysely<Database>): Promise<boolean> {
  try {
    const observed = await sql<Schema>`select c.relname as name, n.nspname as schema, c.relkind as kind,
      (select jsonb_agg(x.value order by x.position) from (
        select a.attnum as position, jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
          'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) as value
        from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped order by a.attnum limit 5
      ) x) as columns,
      (select jsonb_agg(x.value order by x.name) from (
        select k.conname as name, jsonb_build_object('name',k.conname,'kind',k.contype,'validated',k.convalidated,
          'deferrable',k.condeferrable,'definition',pg_get_constraintdef(k.oid)) as value
        from pg_catalog.pg_constraint k where k.conrelid=c.oid order by k.conname limit 4
      ) x) as constraints,
      (select jsonb_agg(x.value order by x.name) from (
        select t.tgname as name, jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid),
          'functionBody',case when octet_length(p.prosrc)<=16384 then p.prosrc else null end,
          'functionLanguage',l.lanname,'securityDefiner',p.prosecdef) as value
        from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid=t.tgfoid join pg_catalog.pg_language l on l.oid=p.prolang
        where t.tgrelid=c.oid and not t.tgisinternal order by t.tgname limit 2
      ) x) as triggers
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where c.oid in(to_regclass('cliniko_request_budgets'),to_regclass('cliniko_request_reservations')) order by c.relname`.execute(db);
    const metadata = observed.rows.map(row => ({ ...row, triggers: row.triggers?.map(trigger => {
      const { functionBody, ...fields } = trigger;
      if (typeof functionBody !== "string") throw Error("Unavailable budget schema");
      return { ...fields, functionBodySha256: createHash("sha256").update(functionBody).digest("hex") };
    }) ?? null }));
    return isDeepStrictEqual(metadata, expected);
  } catch { return false; }
}
