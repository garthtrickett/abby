import type { LedgerStore } from "../core/ledger.ts";
import type { AppointmentHost, AvailabilityHost, PolicyStore } from "../core/host.ts";
import type { TextHost } from "./text-reception.ts";
import { TextReception } from "./text-reception.ts";
import type { ModelWork } from "../model/work.ts";

// The buyer supplies its own call storage, policy storage, and host methods.
// No PostgreSQL schema or standalone process is imported by this composition.
export function createEmbeddedTextComposition(ledger: LedgerStore, policy: PolicyStore, host: TextHost, availability?: AvailabilityHost, appointments?: AppointmentHost, model?: ModelWork): TextReception {
  return new TextReception(ledger, policy, host, availability, appointments, model);
}
