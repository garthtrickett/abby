import { outboundEffectWasImported } from "./postgres-outbound-effect-carryover.ts";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { LocationScope } from "../core/model.ts";
import type Database from "./generated/Database.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { validOutboundEffectRef } from "../core/outbound-effect-barrier.ts";
import { validOutboundEffectScope } from "../portability/outbound-effect-history.ts";

/** Non-patient metadata only; there is deliberately no reset/retry/expiry API.
 * An owning service separately proves current permission, exact provider context
 * and admitted producer/restore state. Local absence cannot prove those facts. */
export class PostgresOutboundEffectBarrier implements OutboundEffectBarrier {
  readonly #db: Kysely<Database>;
  readonly #scope: LocationScope;
  readonly #binding: string;
  constructor(db: Kysely<Database>, scope: LocationScope, ownerBinding: string) {
    if (!validOutboundEffectScope(scope) || typeof ownerBinding !== "string" || !/^[a-f0-9]{64}$/.test(ownerBinding)) {
      throw new TypeError("invalid outbound effect owner");
    }
    this.#db = db; this.#scope = Object.freeze({ ...scope }); this.#binding = ownerBinding;
  }
  matches(scope: LocationScope, ownerBinding: string): boolean {
    return scope?.tenantId === this.#scope.tenantId && scope.clinicId === this.#scope.clinicId &&
      scope.locationId === this.#scope.locationId && ownerBinding === this.#binding;
  }
  async claimOnce(effectRef: string): ReturnType<OutboundEffectBarrier["claimOnce"]> {
    if (!validOutboundEffectRef(effectRef)) return err({ kind: "invalidInput" });
    try {
      return await this.#db.transaction().execute(async trx => {
        // Same tenant lock as import/freeze writers. A retained consumed ID is
        // never recreated, even if the relational barrier was lost on restore.
        await sql`select pg_advisory_xact_lock(172934501, hashtext(${this.#scope.tenantId}))`.execute(trx);
        if (await outboundEffectWasImported(trx, this.#scope.tenantId, effectRef)) {
          const prior = (await sql<{ clinic_id: string; location_id: string; owner_binding: string }>`select
            clinic_id, location_id, owner_binding from outbound_effect_barriers
            where tenant_id = ${this.#scope.tenantId} and effect_ref = ${effectRef}::uuid`.execute(trx)).rows[0];
          if (!prior) return err({ kind: "storageFailure" });
          return prior.clinic_id === this.#scope.clinicId && prior.location_id === this.#scope.locationId && prior.owner_binding === this.#binding
            ? ok({ claimed: false }) : err({ kind: "bindingMismatch" });
        }
        const inserted = await sql`insert into outbound_effect_barriers
          (tenant_id, clinic_id, location_id, effect_ref, owner_binding)
          values (${this.#scope.tenantId}, ${this.#scope.clinicId}, ${this.#scope.locationId}, ${effectRef}::uuid, ${this.#binding})
          on conflict (tenant_id, effect_ref) do nothing returning effect_ref`.execute(trx);
        if (inserted.rows.length === 1) return ok({ claimed: true });
        const prior = (await sql<{ clinic_id: string; location_id: string; owner_binding: string }>`select
          clinic_id, location_id, owner_binding from outbound_effect_barriers
          where tenant_id = ${this.#scope.tenantId} and effect_ref = ${effectRef}::uuid`.execute(trx)).rows[0];
        return prior && prior.clinic_id === this.#scope.clinicId && prior.location_id === this.#scope.locationId &&
          prior.owner_binding === this.#binding ? ok({ claimed: false }) : err({ kind: "bindingMismatch" });
      });
    } catch { return err({ kind: "storageFailure" }); }
  }
}
