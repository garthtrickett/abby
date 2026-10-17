import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { LocationScope } from "../core/model.ts";
import type Database from "./generated/Database.ts";
import type { FinancialEffectBarrier } from "../standalone/financial-effect-barrier.ts";
import { validFinancialEffectRef } from "../standalone/financial-effect-barrier.ts";
import { validFinancialEffectScope } from "../portability/financial-effect-history.ts";

/** Non-patient metadata only; there is deliberately no reset/retry/expiry API.
 * An owning service separately proves current permission, exact provider context
 * and admitted producer/restore state. Local absence cannot prove those facts. */
export class PostgresFinancialEffectBarrier implements FinancialEffectBarrier {
  readonly #db: Kysely<Database>;
  readonly #scope: LocationScope;
  readonly #binding: string;
  constructor(db: Kysely<Database>, scope: LocationScope, ownerBinding: string) {
    if (!validFinancialEffectScope(scope) || typeof ownerBinding !== "string" || !/^[a-f0-9]{64}$/.test(ownerBinding)) {
      throw new TypeError("invalid financial effect owner");
    }
    this.#db = db; this.#scope = Object.freeze({ ...scope }); this.#binding = ownerBinding;
  }
  async claimOnce(effectRef: string): ReturnType<FinancialEffectBarrier["claimOnce"]> {
    if (!validFinancialEffectRef(effectRef)) return err({ kind: "invalidInput" });
    try {
      return await this.#db.transaction().execute(async trx => {
        const inserted = await sql`insert into financial_effect_barriers
          (tenant_id, clinic_id, location_id, effect_ref, owner_binding)
          values (${this.#scope.tenantId}, ${this.#scope.clinicId}, ${this.#scope.locationId}, ${effectRef}::uuid, ${this.#binding})
          on conflict (tenant_id, effect_ref) do nothing returning effect_ref`.execute(trx);
        if (inserted.rows.length === 1) return ok({ claimed: true });
        const prior = (await sql<{ clinic_id: string; location_id: string; owner_binding: string }>`select
          clinic_id, location_id, owner_binding from financial_effect_barriers
          where tenant_id = ${this.#scope.tenantId} and effect_ref = ${effectRef}::uuid`.execute(trx)).rows[0];
        return prior && prior.clinic_id === this.#scope.clinicId && prior.location_id === this.#scope.locationId &&
          prior.owner_binding === this.#binding ? ok({ claimed: false }) : err({ kind: "bindingMismatch" });
      });
    } catch { return err({ kind: "storageFailure" }); }
  }
}
