import type { Kysely } from "kysely";
import type Database from "../storage/generated/Database.ts";
import type { CapabilityMode } from "../core/model.ts";
import type { LedgerStore } from "../core/ledger.ts";
import type { AppointmentHost, AvailabilityHost } from "../core/host.ts";
import { PostgresLedger } from "../storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../storage/postgres-policy-store.ts";
import { referenceDefaultPolicy } from "../reference/policy-store.ts";
import type { TextHost } from "../reference/text-reception.ts";
import { TextReception } from "../reference/text-reception.ts";
import { unprovenReadiness } from "../core/readiness.ts";
import type { AutomationReadiness } from "../core/readiness.ts";

export function createStandaloneTextComposition(db: Kysely<Database>, host: TextHost, hostBookingMode: Extract<CapabilityMode, "execute" | "requestOnly"> = "execute", ledger: LedgerStore = new PostgresLedger(db), availability?: AvailabilityHost, appointments?: AppointmentHost, readiness: AutomationReadiness = unprovenReadiness): Readonly<{ reception: TextReception; policy: PostgresPolicyStore }> {
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, hostBookingMode, readiness);
  return { reception: new TextReception(ledger, policy, host, availability, appointments), policy };
}
