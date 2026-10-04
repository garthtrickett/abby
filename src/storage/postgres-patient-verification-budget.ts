import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { LocationScope } from "../core/model.ts";
import type { PatientVerificationBudget } from "../standalone/email-patient-authority.ts";
import type Database from "./generated/Database.ts";
import type { PatientVerificationBudgetsTenantId, PatientVerificationBudgetsClinicId,
  PatientVerificationBudgetsKind } from "./generated/public/PatientVerificationBudgets.ts";

/** All callers/locations of one clinic share two fixed five-minute windows across processes. */
export class PostgresPatientVerificationBudget implements PatientVerificationBudget {
  readonly #db: Kysely<Database>;
  readonly #scope: Pick<LocationScope, "tenantId" | "clinicId">;
  constructor(db: Kysely<Database>, scope: Pick<LocationScope, "tenantId" | "clinicId">) {
    if (!scope || ![scope.tenantId, scope.clinicId].every(value => typeof value === "string" &&
        !!value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value))) throw new TypeError("invalid verification budget scope");
    this.#db = db; this.#scope = Object.freeze({ ...scope });
  }

  async reserve(scope: LocationScope, kind: "issue" | "answer"): Promise<boolean> {
    if (!scope || scope.tenantId !== this.#scope.tenantId || scope.clinicId !== this.#scope.clinicId ||
        (kind !== "issue" && kind !== "answer")) return false;
    const key = { tenant_id: this.#scope.tenantId as PatientVerificationBudgetsTenantId,
      clinic_id: this.#scope.clinicId as PatientVerificationBudgetsClinicId, kind: kind as PatientVerificationBudgetsKind };
    try {
      return await this.#db.transaction().execute(async trx => {
        await sql`set local lock_timeout = '1000ms'`.execute(trx);
        await sql`set local statement_timeout = '2000ms'`.execute(trx);
        await trx.insertInto("patient_verification_budgets").values(key)
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "kind"]).doNothing()).execute();
        const state = await trx.selectFrom("patient_verification_budgets")
          .select(["attempts", "window_started_at", sql<boolean>`window_started_at <= clock_timestamp() - interval '5 minutes'`.as("expired")])
          .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id).where("kind", "=", key.kind)
          .forUpdate().executeTakeFirstOrThrow();
        const attempts = state.expired ? 0 : state.attempts;
        if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts >= (kind === "issue" ? 30 : 90)) return false;
        await trx.updateTable("patient_verification_budgets").set({ attempts: attempts + 1,
          window_started_at: state.expired ? sql`clock_timestamp()` : state.window_started_at })
          .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id).where("kind", "=", key.kind).execute();
        return true;
      });
    } catch { return false; }
  }
}
