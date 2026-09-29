import type { Kysely } from "kysely";
import type Database from "../storage/generated/Database.ts";
import type { KnowledgeHost, ModelKnowledgeContextHost } from "../core/host.ts";
import { ClinikoAvailabilityReader } from "../cliniko/availability.ts";
import { PostgresLedger } from "../storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../storage/postgres-policy-store.ts";
import { referenceDefaultPolicy } from "../reference/policy-store.ts";
import type { TextHost } from "../reference/text-reception.ts";
import { TextReception } from "../reference/text-reception.ts";
import { unprovenReadiness } from "../core/readiness.ts";
import { NoStoredKnowledge } from "./no-stored-knowledge.ts";

/** Standalone patient-specific actions stay off until Cliniko-owned work is implemented and proven. */
export function createStandaloneTextComposition(db: Kysely<Database>, host: TextHost,
                                                availability?: ClinikoAvailabilityReader):
  Readonly<{ reception: TextReception; policy: PostgresPolicyStore; knowledge: KnowledgeHost & Partial<ModelKnowledgeContextHost> }> {
  if (availability !== undefined && !(availability instanceof ClinikoAvailabilityReader)) {
    throw new Error("standalone availability requires a Cliniko reader");
  }
  const ledger = new PostgresLedger(db, undefined, unprovenReadiness, "standaloneText");
  const knowledge = new NoStoredKnowledge();
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable", unprovenReadiness, false, "standaloneMinimal");
  return { reception: new TextReception(ledger, policy, host, availability, undefined, undefined, knowledge), policy, knowledge };
}
