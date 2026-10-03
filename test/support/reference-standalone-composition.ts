import { withApprovedSyntheticVoice } from "./approved-voice.ts";
import type { Kysely } from "kysely";
import type Database from "../../src/storage/generated/Database.ts";
import type { CapabilityMode } from "../../src/core/model.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import type { EffectCallLeaseStore } from "../../src/core/effect-call-lease.ts";
import type { AppointmentHost, AvailabilityHost, KnowledgeHost, ModelKnowledgeContextHost } from "../../src/core/host.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import type { TextHost } from "../../src/reference/text-reception.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { unprovenReadiness } from "../../src/core/readiness.ts";
import type { AutomationReadiness } from "../../src/core/readiness.ts";
import type { ModelWork } from "../../src/model/work.ts";
import { PostgresKnowledgeCatalogue } from "../../src/storage/postgres-knowledge-catalogue.ts";

/** Reference-only fixture with explicit synthetic speech approval for executable and request-only journeys. */
export function createReferenceStandaloneTextComposition(db: Kysely<Database>, host: TextHost, hostBookingMode: CapabilityMode,
                                                         ledger: LedgerStore & EffectCallLeaseStore = new PostgresLedger(db, undefined, undefined, "unsafeReference"), availability?: AvailabilityHost,
                                                         appointments?: AppointmentHost, readiness: AutomationReadiness = unprovenReadiness,
                                                         model?: ModelWork,
                                                         knowledge: KnowledgeHost & Partial<ModelKnowledgeContextHost> = new PostgresKnowledgeCatalogue(db, "unsafeReference")):
  Readonly<{ reception: TextReception; policy: PostgresPolicyStore; knowledge: KnowledgeHost & Partial<ModelKnowledgeContextHost> }> {
  const policy = withApprovedSyntheticVoice(new PostgresPolicyStore(db, referenceDefaultPolicy, hostBookingMode, readiness, true, "unsafeReference"));
  return { reception: new TextReception(ledger, policy, host, availability, appointments, model, knowledge), policy, knowledge };
}
