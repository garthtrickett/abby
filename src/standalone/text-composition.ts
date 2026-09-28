import type { Kysely } from "kysely";
import type Database from "../storage/generated/Database.ts";
import type { CapabilityMode } from "../core/model.ts";
import type { LedgerStore } from "../core/ledger.ts";
import type { AppointmentHost, AvailabilityHost, KnowledgeHost, ModelKnowledgeContextHost } from "../core/host.ts";
import { PostgresLedger } from "../storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../storage/postgres-policy-store.ts";
import { referenceDefaultPolicy } from "../reference/policy-store.ts";
import type { TextHost } from "../reference/text-reception.ts";
import { TextReception } from "../reference/text-reception.ts";
import { unprovenReadiness } from "../core/readiness.ts";
import type { AutomationReadiness } from "../core/readiness.ts";
import type { ModelWork } from "../model/work.ts";
import { PostgresKnowledgeCatalogue } from "../storage/postgres-knowledge-catalogue.ts";

export function createStandaloneTextComposition(db: Kysely<Database>, host: TextHost, hostBookingMode: Extract<CapabilityMode, "execute" | "requestOnly"> = "requestOnly", ledger: LedgerStore = new PostgresLedger(db), availability?: AvailabilityHost, appointments?: AppointmentHost, readiness: AutomationReadiness = unprovenReadiness, model?: ModelWork,
                                                knowledge: KnowledgeHost & Partial<ModelKnowledgeContextHost> = new PostgresKnowledgeCatalogue(db)): Readonly<{ reception: TextReception; policy: PostgresPolicyStore; knowledge: KnowledgeHost & Partial<ModelKnowledgeContextHost> }> {
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, hostBookingMode, readiness);
  return { reception: new TextReception(ledger, policy, host, availability, appointments, model, knowledge), policy, knowledge };
}
