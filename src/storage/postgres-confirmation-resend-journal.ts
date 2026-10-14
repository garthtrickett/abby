import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { LocationScope } from "../core/model.ts";
import type Database from "./generated/Database.ts";
import { confirmationResendRef, validResendSubmission } from "../standalone/confirmation-resend-journal.ts";
import type { ConfirmationResendJournal, ConfirmationResendStatus } from "../standalone/confirmation-resend-journal.ts";
import type { SmtpMailSubmission } from "../standalone/smtp-text-mail-transport.ts";

type Row = { clinic_id: string; location_id: string; owner_binding: string; status: string; message_ref: string | null };
const scopePart = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0 &&
  value.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(value);
function status(row: Row): ConfirmationResendStatus {
  if (row.status === "accepted" && confirmationResendRef(row.message_ref)) return { kind: "accepted", messageRef: row.message_ref };
  if (row.message_ref === null && (row.status === "possiblySent" || row.status === "unknown" || row.status === "definitiveUnsent")) return { kind: row.status };
  throw new Error("invalid resend journal state");
}

/** Scoped trusted owner. The first durable claim burns the UUID permanently.
 * Restart, competing calls, a new source binding and unknown/rejected sends cannot replay it. */
export class PostgresConfirmationResendJournal implements ConfirmationResendJournal {
  readonly #db: Kysely<Database>;
  readonly #scope: LocationScope;
  readonly #binding: string;
  constructor(db: Kysely<Database>, scope: LocationScope, ownerBinding: string) {
    if (!scope || ![scope.tenantId, scope.clinicId, scope.locationId].every(scopePart) || typeof ownerBinding !== "string" ||
        !/^[a-f0-9]{64}$/.test(ownerBinding)) throw new TypeError("invalid resend journal binding");
    this.#db = db; this.#scope = Object.freeze({ ...scope }); this.#binding = ownerBinding;
  }
  #matches(row: Row): boolean { return row.clinic_id === this.#scope.clinicId && row.location_id === this.#scope.locationId && row.owner_binding === this.#binding; }
  async claim(requestRef: string): ReturnType<ConfirmationResendJournal["claim"]> {
    if (!confirmationResendRef(requestRef)) return err({ kind: "invalidInput" });
    try {
      return await this.#db.transaction().execute(async trx => {
        const inserted = await sql<Row>`insert into confirmation_resend_journal
          (tenant_id, clinic_id, location_id, request_ref, owner_binding, status)
          values (${this.#scope.tenantId}, ${this.#scope.clinicId}, ${this.#scope.locationId}, ${requestRef}::uuid, ${this.#binding}, 'possiblySent')
          on conflict (tenant_id, request_ref) do nothing returning clinic_id, location_id, owner_binding, status, message_ref`.execute(trx);
        if (inserted.rows[0]) return ok({ send: true, status: status(inserted.rows[0]) });
        const existing = await sql<Row>`select clinic_id, location_id, owner_binding, status, message_ref from confirmation_resend_journal
          where tenant_id = ${this.#scope.tenantId} and request_ref = ${requestRef}::uuid`.execute(trx);
        const row = existing.rows[0];
        return row && this.#matches(row) ? ok({ send: false, status: status(row) }) : err({ kind: "bindingMismatch" });
      });
    } catch { return err({ kind: "storageFailure" }); }
  }
  async read(requestRef: string): ReturnType<ConfirmationResendJournal["read"]> {
    if (!confirmationResendRef(requestRef)) return err({ kind: "invalidInput" });
    try {
      const found = await sql<Row>`select clinic_id, location_id, owner_binding, status, message_ref from confirmation_resend_journal
        where tenant_id = ${this.#scope.tenantId} and request_ref = ${requestRef}::uuid`.execute(this.#db);
      const row = found.rows[0];
      return !row ? ok(null) : this.#matches(row) ? ok(status(row)) : err({ kind: "bindingMismatch" });
    } catch { return err({ kind: "storageFailure" }); }
  }
  async finish(requestRef: string, result: SmtpMailSubmission): ReturnType<ConfirmationResendJournal["finish"]> {
    if (!confirmationResendRef(requestRef) || !validResendSubmission(result)) return err({ kind: "invalidInput" });
    const messageRef = result.kind === "accepted" ? result.messageRef : null;
    try {
      const updated = await sql`update confirmation_resend_journal set status = ${result.kind}, message_ref = ${messageRef}::uuid, completed_at = clock_timestamp()
        where tenant_id = ${this.#scope.tenantId} and clinic_id = ${this.#scope.clinicId} and location_id = ${this.#scope.locationId}
          and owner_binding = ${this.#binding} and request_ref = ${requestRef}::uuid and status = 'possiblySent' returning request_ref`.execute(this.#db);
      if (updated.rows.length === 1) return ok(true);
      const prior = await this.read(requestRef);
      return prior.ok && prior.value?.kind === result.kind &&
        (result.kind !== "accepted" || prior.value.kind === "accepted" && prior.value.messageRef === result.messageRef)
        ? ok(true) : err({ kind: "invalidTransition" });
    } catch { return err({ kind: "storageFailure" }); }
  }
}
