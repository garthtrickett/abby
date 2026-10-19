import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { LocationScope } from "../core/model.ts";
import type { OutboundCapacity } from "../core/outbound-capacity.ts";
import { validOutboundEffectRef } from "../core/outbound-effect-barrier.ts";
import { validOutboundEffectScope } from "../portability/outbound-effect-history.ts";
import { carryOutboundCapacityOrigins, readOutboundCapacityCarryover } from "./postgres-outbound-capacity-carryover.ts";
import type Database from "./generated/Database.ts";

/** Trusted storage port: release is not exposed as an HTTP command. The owning
 * protocol separately proves definite no-dispatch or authenticated exact terminal
 * evidence. No lease, timeout, process exit or local absence releases a place. */
export class PostgresOutboundCapacity implements OutboundCapacity {
  readonly #db: Kysely<Database>;
  readonly #scope: LocationScope;
  readonly #binding: string;
  constructor(db: Kysely<Database>, scope: LocationScope, ownerBinding: string) {
    if (!validOutboundEffectScope(scope) || !/^[a-f0-9]{64}$/.test(ownerBinding)) throw new TypeError("invalid outbound capacity owner");
    this.#db = db; this.#scope = Object.freeze({ ...scope }); this.#binding = ownerBinding;
  }
  matches(scope: LocationScope, ownerBinding: string): boolean {
    return scope?.tenantId === this.#scope.tenantId && scope.clinicId === this.#scope.clinicId &&
      scope.locationId === this.#scope.locationId && ownerBinding === this.#binding;
  }
  async acquireOnce(ref: string, maximum: number): ReturnType<OutboundCapacity["acquireOnce"]> {
    if (!validOutboundEffectRef(ref) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) return err({ kind: "invalidInput" });
    try {
      return await this.#db.transaction().execute(async trx => {
        await sql`select pg_advisory_xact_lock(172934501, hashtext(${this.#scope.tenantId}))`.execute(trx);
        const history = await carryOutboundCapacityOrigins(trx, this.#scope.tenantId, await readOutboundCapacityCarryover(trx, this.#scope.tenantId));
        const prior = history.find(r => r.allocation.allocationRef === ref);
        if (prior) return prior.clinicId === this.#scope.clinicId && prior.locationId === this.#scope.locationId && prior.allocation.ownerBinding === this.#binding
          ? ok({ kind: "alreadyUsed" as const }) : err({ kind: "bindingMismatch" as const });
        // Count the campaign across locations/policy/provider revisions. Scope
        // remapping and changed policy cannot hide a possibly live old call.
        if (history.filter(r => r.allocation.ownerBinding === this.#binding && r.allocation.releasedAt === null).length >= maximum)
          return ok({ kind: "full" as const });
        await sql`insert into outbound_capacity_allocations (tenant_id, clinic_id, location_id, allocation_ref, owner_binding)
          values (${this.#scope.tenantId}, ${this.#scope.clinicId}, ${this.#scope.locationId}, ${ref}::uuid, ${this.#binding})`.execute(trx);
        return ok({ kind: "acquired" as const });
      });
    } catch { return err({ kind: "storageFailure" }); }
  }
  async releaseOnce(ref: string, beforeRelease?: () => boolean): ReturnType<OutboundCapacity["releaseOnce"]> {
    if (!validOutboundEffectRef(ref)) return err({ kind: "invalidInput" });
    try {
      return await this.#db.transaction().execute(async trx => {
        await sql`select pg_advisory_xact_lock(172934501, hashtext(${this.#scope.tenantId}))`.execute(trx);
        const history = await carryOutboundCapacityOrigins(trx, this.#scope.tenantId, await readOutboundCapacityCarryover(trx, this.#scope.tenantId));
        const prior = history.find(r => r.allocation.allocationRef === ref);
        if (!prior || prior.clinicId !== this.#scope.clinicId || prior.locationId !== this.#scope.locationId || prior.allocation.ownerBinding !== this.#binding)
          return err({ kind: "bindingMismatch" as const });
        if (prior.allocation.releasedAt !== null) return ok({ released: false });
        if (beforeRelease && beforeRelease() !== true) return err({ kind: "forbidden" as const });
        const row = await sql`update outbound_capacity_allocations set released_at = clock_timestamp()
          where tenant_id = ${this.#scope.tenantId} and allocation_ref = ${ref}::uuid and released_at is null returning allocation_ref`.execute(trx);
        return ok({ released: row.rows.length === 1 });
      });
    } catch { return err({ kind: "storageFailure" }); }
  }
}
