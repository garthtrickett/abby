import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { NativeOutboundRecords } from "./internal/outbound-native-record.ts";
import type { NativeOutboundContext, NativeOutboundFailure, NativeOutboundReadAuthority, NativeOutboundReadBinding, NativeOutboundRetention } from "./internal/outbound-native-record.ts";
import { outboundConfigShard } from "./internal/outbound-record-context.ts";
import { clinikoCredentialFingerprint } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { decodeTwilioOutboundReport, encodeTwilioOutboundReport, twilioOutboundReportDigest, TwilioOutboundReportAuthentication } from "./twilio-outbound-report.ts";
import type { TwilioOutboundReport } from "./twilio-outbound-report.ts";
import type { TwilioOriginalCall } from "../voice/twilio-outbound-context.ts";

export type TwilioOutboundReportConfig = Readonly<{
  scope: LocationScope; businessId: string; apiKey: string; contactEmail: string;
  outboundProviderReportRecallTypeId: string; providerReportPolicyDigest: string;
  rateBudget: ClinikoRequestBudget; clock?: () => string; deadlineMs?: number;
}>;
type Selection = Readonly<{
  scope: LocationScope; businessId: string; credentialFingerprint: string;
  outboundProviderReportRecallTypeId: string; providerReportPolicyDigest: string;
  provider: ReturnType<TwilioOutboundReportAuthentication["binding"]>;
  authenticationBinding: string;
}>;
export type TwilioOutboundReportQuery = Selection & Readonly<{
  ownerBinding: string; operation: "retainProviderReport" | "readProviderReport";
  actionRef: string; patientId: string; recallRef?: string; recallAt?: string; includeArchived?: true;
  report?: TwilioOutboundReport; reportDigest?: string;
}>;
export type TwilioOutboundReportReadAuthority = NativeOutboundReadAuthority<TwilioOutboundReportQuery>;
export type TwilioOutboundReportWriteAuthority = TwilioOutboundReportReadAuthority & Readonly<{
  producerAdmitted(query: TwilioOutboundReportQuery, signal: AbortSignal): Promise<boolean>;
}>;
function selection(c: TwilioOutboundReportConfig, auth: TwilioOutboundReportAuthentication): Selection {
  return Object.freeze({ scope: Object.freeze({ ...c.scope }), businessId: c.businessId, credentialFingerprint: clinikoCredentialFingerprint(c.apiKey),
    outboundProviderReportRecallTypeId: c.outboundProviderReportRecallTypeId, providerReportPolicyDigest: c.providerReportPolicyDigest,
    provider: auth.binding(), authenticationBinding: auth.authenticationBinding() });
}
function shard(c: TwilioOutboundReportConfig, port: typeof fetch): string | undefined {
  return outboundConfigShard({ ...c, outboundRecallTypeId: c.outboundProviderReportRecallTypeId, recordPolicyDigest: c.providerReportPolicyDigest }, port);
}
export function twilioOutboundReportRecordBinding(c: TwilioOutboundReportConfig, auth: TwilioOutboundReportAuthentication): string | undefined {
  try {
    if (!(auth instanceof TwilioOutboundReportAuthentication) || !shard(c, fetch)) return;
    const s = selection(c, auth);
    // Key selection is independently authorized in every query. It must not
    // partition the permanent action: changing a verifier cannot reset a claim.
    return createHash("sha256").update(JSON.stringify(["abby.twilio-report-record.v1", s.scope.tenantId, s.scope.clinicId, s.scope.locationId,
      s.businessId, s.credentialFingerprint, s.outboundProviderReportRecallTypeId, s.providerReportPolicyDigest, s.provider.ref, s.provider.bindingDigest])).digest("hex");
  } catch { return; }
}
/** Authenticated evidence in a dedicated clinic-owned family. It is deliberately
 * not an OutboundTerminalProvider or settlement provider: integrity alone cannot
 * prove complete producer coverage or permit hold release. A future producer
 * must authenticate actual stop evidence; complete no-stop additionally needs
 * actual provider/speech closure. A positive stop can precede that closure. */
export class ClinikoTwilioOutboundReportRecords {
  readonly #records: NativeOutboundRecords<TwilioOutboundReport, TwilioOutboundReportQuery>;
  readonly #matchesOriginal: TwilioOutboundReportAuthentication["matchesOriginal"];
  private constructor(c: TwilioOutboundReportConfig, auth: TwilioOutboundReportAuthentication, sourceShard: string, owner: string,
    authority: TwilioOutboundReportReadAuthority, port: typeof fetch,
    write?: Readonly<{ authority: TwilioOutboundReportWriteAuthority; effects: OutboundEffectBarrier }>) {
    const s = selection(c, auth), verify = auth.verify.bind(auth);
    this.#matchesOriginal = auth.matchesOriginal.bind(auth);
    this.#records = new NativeOutboundRecords({ ...c, scope: s.scope, credentialFingerprint: s.credentialFingerprint, typeId: s.outboundProviderReportRecallTypeId },
      sourceShard, owner, authority, port, {
        encode: v => verify(v) ? encodeTwilioOutboundReport(v) : err({ kind: "invalidTwilioOutboundReport" }),
        decode: notes => { const v = decodeTwilioOutboundReport(notes); return v.ok && verify(v.value) ? v : err({ kind: "invalidTwilioOutboundReport" }); },
        recordedAt: v => v.recordedAt, expiresAt: () => "9999-12-31T23:59:59.999Z",
      }, q => Object.freeze({ ...s, ownerBinding: owner, operation: q.method === "POST" ? "retainProviderReport" : "readProviderReport",
        actionRef: q.actionRef, patientId: q.patientId, ...(q.method === "GET" ? { includeArchived: true as const } : {}),
        ...(q.recallRef ? { recallRef: q.recallRef } : {}), ...(q.recallAt ? { recallAt: q.recallAt } : {}),
        ...(q.record ? { report: q.record, reportDigest: twilioOutboundReportDigest(q.record)! } : {}) }),
      write ? { barrier: write.effects, producer: write.authority.producerAdmitted.bind(write.authority) } : undefined);
  }
  static create(c: TwilioOutboundReportConfig, auth: TwilioOutboundReportAuthentication, authority: TwilioOutboundReportWriteAuthority,
    effects: OutboundEffectBarrier, port: typeof fetch = fetch): Result<ClinikoTwilioOutboundReportRecords, NativeOutboundFailure> {
    try {
      const sourceShard = shard(c, port), owner = twilioOutboundReportRecordBinding(c, auth);
      if (!sourceShard || !owner || [authority?.allows, authority?.current, authority?.producerAdmitted, effects?.matches, effects?.claimOnce].some(f => typeof f !== "function") ||
          effects.matches(c.scope, owner) !== true) return err({ kind: "invalidConfig" });
      return ok(new ClinikoTwilioOutboundReportRecords(c, auth, sourceShard, owner, authority, port, { authority, effects }));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  static createReadOnly(c: TwilioOutboundReportConfig, auth: TwilioOutboundReportAuthentication, authority: TwilioOutboundReportReadAuthority,
    port: typeof fetch = fetch): Result<Pick<ClinikoTwilioOutboundReportRecords, "readReport">, NativeOutboundFailure> {
    try {
      const sourceShard = shard(c, port), owner = twilioOutboundReportRecordBinding(c, auth);
      if (!sourceShard || !owner || [authority?.allows, authority?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      const records = new ClinikoTwilioOutboundReportRecords(c, auth, sourceShard, owner, authority, port);
      return ok(Object.freeze({ readReport: records.readReport.bind(records) }));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  retainReportOnce(report: TwilioOutboundReport, original: TwilioOriginalCall, accountSid: string, recallAt: string,
    signal: AbortSignal): Promise<Result<NativeOutboundRetention, NativeOutboundFailure>> {
    if (!this.#matchesOriginal(report, original, accountSid)) return Promise.resolve(err({ kind: "invalidQuery" }));
    return this.#records.retain(report, recallAt, signal);
  }
  readReport(binding: NativeOutboundReadBinding, signal: AbortSignal): Promise<Result<NativeOutboundContext<TwilioOutboundReport>, NativeOutboundFailure>> {
    return this.#records.read(binding, signal);
  }
}
