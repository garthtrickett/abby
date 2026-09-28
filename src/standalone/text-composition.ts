import type { Kysely } from "kysely";
import type Database from "../storage/generated/Database.ts";
import type { CapabilityMode } from "../core/model.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { PostgresLedger } from "../storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../storage/postgres-policy-store.ts";
import { referenceDefaultPolicy } from "../reference/policy-store.ts";
import type { TextHost } from "../reference/text-reception.ts";
import { TextReception } from "../reference/text-reception.ts";

export function createStandaloneTextComposition(db: Kysely<Database>, host: TextHost, hostBookingMode: Extract<CapabilityMode, "execute" | "requestOnly"> = "execute", ledger: LedgerStore = new PostgresLedger(db)): Readonly<{ reception: TextReception; policy: PostgresPolicyStore }> {
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, hostBookingMode);
  return { reception: new TextReception(ledger, policy, host), policy };
}
