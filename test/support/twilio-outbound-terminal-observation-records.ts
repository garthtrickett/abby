import { ClinikoTwilioOutboundTerminalObservationRecords, twilioOutboundTerminalObservationRecordBinding } from "../../src/cliniko/twilio-outbound-terminal-observation-records.ts";
import type { TwilioOutboundTerminalObservationQuery, TwilioOutboundTerminalObservationConfig } from "../../src/cliniko/twilio-outbound-terminal-observation-records.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { twilioOutboundTerminalObservationValue } from "./twilio-outbound-terminal-observation.ts";
import { outboundRecordsFixture, value } from "./outbound-records.ts";

type Options = Pick<NonNullable<Parameters<typeof outboundRecordsFixture>[0]>, "response" | "deadlineMs">;
export async function twilioOutboundTerminalObservationRecordsFixture(options: Options = {}) {
  const native = await outboundRecordsFixture({ typeId: "66", ...options });
  const f = twilioOutboundTerminalObservationValue({ credentialFingerprint: clinikoCredentialFingerprint(native.config.apiKey) });
  native.setNow(f.observation.recordedAt);
  const config: TwilioOutboundTerminalObservationConfig = { ...native.config, scope: f.observation.scope, businessId: f.observation.businessId,
    outboundTerminalObservationRecallTypeId: "66", terminalObservationPolicyDigest: "a".repeat(64) };
  const owner = twilioOutboundTerminalObservationRecordBinding(config, f.auth)!, burned = new Set<string>(), queries: TwilioOutboundTerminalObservationQuery[] = [];
  const state = { live: true, allowed: true, producer: true, decoded: true };
  const authority = { allows: async (q: TwilioOutboundTerminalObservationQuery) => { queries.push(q); return state.allowed && (!q.observation || state.decoded); },
    current: () => state.live, producerAdmitted: async () => state.producer };
  const effects = { matches: (scope: typeof config.scope, binding: string) => JSON.stringify(scope) === JSON.stringify(config.scope) && binding === owner,
    claimOnce: async (ref: string) => { const claimed = !burned.has(ref); burned.add(ref); return { ok: true as const, value: { claimed } }; } };
  const records = value(ClinikoTwilioOutboundTerminalObservationRecords.create(config, f.auth, authority, effects, native.port));
  const retain = () => records.retainObservationOnce(f.observation, f.context, f.observation.accountSid, "2026-11-02", new AbortController().signal);
  return { ...f, native, config, owner, burned, queries, state, authority, effects, records, retain };
}
