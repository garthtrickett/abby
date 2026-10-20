import { ClinikoTwilioOutboundReportRecords, twilioOutboundReportRecordBinding } from "../../src/cliniko/twilio-outbound-report-records.ts";
import type { TwilioOutboundReportQuery, TwilioOutboundReportConfig } from "../../src/cliniko/twilio-outbound-report-records.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { twilioOutboundReportValue } from "./twilio-outbound-report.ts";
import { outboundRecordsFixture, value } from "./outbound-records.ts";

export async function twilioOutboundReportRecordsFixture() {
  const native = await outboundRecordsFixture({ typeId: "64" });
  const f = twilioOutboundReportValue(true, { credentialFingerprint: clinikoCredentialFingerprint(native.config.apiKey) });
  native.setNow(f.report.recordedAt);
  const config: TwilioOutboundReportConfig = { ...native.config, scope: f.report.scope, businessId: f.report.businessId,
    outboundProviderReportRecallTypeId: "64", providerReportPolicyDigest: "a".repeat(64) };
  const owner = twilioOutboundReportRecordBinding(config, f.auth)!, burned = new Set<string>(), queries: TwilioOutboundReportQuery[] = [];
  const state = { live: true, allowed: true, producer: true, decoded: true };
  const authority = { allows: async (q: TwilioOutboundReportQuery) => { queries.push(q); return state.allowed && (!q.report || state.decoded); },
    current: () => state.live, producerAdmitted: async () => state.producer };
  const effects = { matches: (scope: typeof config.scope, binding: string) => JSON.stringify(scope) === JSON.stringify(config.scope) && binding === owner,
    claimOnce: async (ref: string) => { const claimed = !burned.has(ref); burned.add(ref); return { ok: true as const, value: { claimed } }; } };
  const records = value(ClinikoTwilioOutboundReportRecords.create(config, f.auth, authority, effects, native.port));
  const retain = () => records.retainReportOnce(f.report, f.context, f.report.accountSid, "2026-11-02", new AbortController().signal);
  return { ...f, native, config, owner, burned, queries, state, authority, effects, records, retain };
}
