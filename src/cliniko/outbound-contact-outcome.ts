import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { formatRecallNote, validRecallMarker, validRecallSummary } from "./recall-note.ts";
import { packUuid, unpackUuid, packDigest, unpackDigest, packRecall, unpackRecall } from "./internal/outbound-note-packing.ts";
import { outboundLaunchAttemptDigest } from "./outbound-launch-attempt.ts";
import type { OutboundLaunchRecord } from "./outbound-launch-records.ts";

/** Private native completion evidence, not patient/clinical authority. Neither
 * this object nor its digest belongs in standalone local persistence. The exact
 * attempt digest binds provider/settings and private original call context. */
export type OutboundContactOutcome = Readonly<{
  actionRef: string; scope: LocationScope; businessId: string; credentialFingerprint: string; patientId: string;
  attempt: Readonly<{ recallRef: string; actionRef: string; digest: string }>;
  result: Readonly<{ kind: "completeNoStop"; reportDigest: string }> | Readonly<{ kind: "stopRetained"; reportDigest: string;
    decision: Readonly<{ recallRef: string; actionRef: string; digest: string }> }>;
  terminal: Readonly<{ endedAt: string; observedAt: string }>;
  reportedAt: string; recordedAt: string;
}>;
type Failure = Readonly<{ kind: "invalidOutboundContactOutcome" }>;
const invalid = () => err({ kind: "invalidOutboundContactOutcome" as const });
const header = "Abby outbound contact outcome v1";
const instruction = "Contact settlement evidence only. No call permission, patient verification or clinical result. Never replay this effect.";
const exact = (v: unknown, keys: readonly string[]) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const opaque = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v);
const numeric = (v: unknown) => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const recall = (v: unknown) => typeof v === "string" && /^cliniko:recall:[1-9][0-9]{0,18}$/.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function valid(v: OutboundContactOutcome): boolean {
  if (!exact(v,["actionRef","scope","businessId","credentialFingerprint","patientId","attempt","result","terminal","reportedAt","recordedAt"]) ||
      !validRecallMarker(v.actionRef) || !exact(v.scope,["tenantId","clinicId","locationId"]) || !Object.values(v.scope).every(opaque) ||
      !numeric(v.businessId) || !numeric(v.patientId) || !digest(v.credentialFingerprint) ||
      !exact(v.attempt,["recallRef","actionRef","digest"]) || !recall(v.attempt.recallRef) || !validRecallMarker(v.attempt.actionRef) || !digest(v.attempt.digest) || v.actionRef===v.attempt.actionRef ||
      !exact(v.terminal,["endedAt","observedAt"]) || ![v.terminal.endedAt,v.terminal.observedAt,v.reportedAt,v.recordedAt].every(instant) ||
      v.terminal.endedAt>v.terminal.observedAt || v.terminal.observedAt>v.recordedAt || v.reportedAt>v.recordedAt) return false;
  if (exact(v.result,["kind","reportDigest"]) && v.result.kind==="completeNoStop") return digest(v.result.reportDigest);
  return exact(v.result,["kind","reportDigest","decision"]) && v.result.kind==="stopRetained" && digest(v.result.reportDigest) &&
    exact(v.result.decision,["recallRef","actionRef","digest"]) && recall(v.result.decision.recallRef) && validRecallMarker(v.result.decision.actionRef) && digest(v.result.decision.digest) &&
    ![v.actionRef,v.attempt.actionRef].includes(v.result.decision.actionRef) && v.attempt.recallRef!==v.result.decision.recallRef;
}
export function encodeOutboundContactOutcome(v: OutboundContactOutcome): Result<string,Failure> {
  try {
    if (!valid(v)) return invalid();
    const payload=[[v.scope.tenantId,v.scope.clinicId,v.scope.locationId],v.businessId,packDigest(v.credentialFingerprint),v.patientId,
      [packRecall(v.attempt.recallRef),packUuid(v.attempt.actionRef),packDigest(v.attempt.digest)],
      [v.result.kind==="stopRetained"?1:0,packDigest(v.result.reportDigest),...(v.result.kind==="stopRetained"?[[packRecall(v.result.decision.recallRef),packUuid(v.result.decision.actionRef),packDigest(v.result.decision.digest)]]:[])],
      v.terminal.endedAt,v.terminal.observedAt,v.reportedAt,v.recordedAt];
    const summary=`${header}\n${JSON.stringify(payload)}\n${instruction}`;
    return validRecallSummary(summary)?ok(formatRecallNote(v.actionRef,summary)):invalid();
  } catch { return invalid(); }
}
export function decodeOutboundContactOutcome(notes: unknown): Result<OutboundContactOutcome,Failure> {
  try {
    if (typeof notes!=="string" || notes.length>1050) return invalid(); const lines=notes.split("\n");
    if (lines.length!==4 || !lines[0]!.startsWith("Abby request ") || lines[1]!==header || lines[3]!==instruction) return invalid();
    const a:unknown=JSON.parse(lines[2]!);
    if (!Array.isArray(a) || a.length!==10 || !Array.isArray(a[0]) || a[0].length!==3 || !Array.isArray(a[4]) || a[4].length!==3 ||
        !Array.isArray(a[5]) || ![2,3].includes(a[5].length) || ![0,1].includes(a[5][0]) ||
        a[5].length===3 && (!Array.isArray(a[5][2]) || a[5][2].length!==3)) return invalid();
    if (a[5][0]===0 && a[5].length!==2 || a[5][0]===1 && a[5].length!==3) return invalid();
    const contact:OutboundContactOutcome["result"] = a[5][0]===0 ? {kind:"completeNoStop",reportDigest:unpackDigest(a[5][1])} :
      {kind:"stopRetained",reportDigest:unpackDigest(a[5][1]),decision:{recallRef:unpackRecall(a[5][2][0]),actionRef:unpackUuid(a[5][2][1]),digest:unpackDigest(a[5][2][2])}};
    const result:OutboundContactOutcome={actionRef:lines[0]!.slice(13),scope:{tenantId:a[0][0],clinicId:a[0][1],locationId:a[0][2]},businessId:a[1],credentialFingerprint:unpackDigest(a[2]),patientId:a[3],
      attempt:{recallRef:unpackRecall(a[4][0]),actionRef:unpackUuid(a[4][1]),digest:unpackDigest(a[4][2])},
      result:contact,
      terminal:{endedAt:a[6],observedAt:a[7]},reportedAt:a[8],recordedAt:a[9]};
    const encoded=encodeOutboundContactOutcome(result);if(!encoded.ok || encoded.value!==notes)return invalid();
    return ok(Object.freeze({...result,scope:Object.freeze({...result.scope}),attempt:Object.freeze({...result.attempt}),
      result:Object.freeze({...result.result,...(result.result.kind==="stopRetained"?{decision:Object.freeze({...result.result.decision})}:{})}),terminal:Object.freeze({...result.terminal})}));
  } catch { return invalid(); }
}
export function outboundContactOutcomeDigest(outcome: OutboundContactOutcome): string|undefined {
  const encoded=encodeOutboundContactOutcome(outcome);return encoded.ok?createHash("sha256").update(JSON.stringify(["abby.outbound-contact-outcome.v1",encoded.value])).digest("hex"):undefined;
}
/** Exact binding only. Native/provider/clinic grants must still be current. */
export function outboundContactOutcomeMatchesAttempt(outcome: OutboundContactOutcome, record: OutboundLaunchRecord): boolean {
  try {
    const a=record.attempt;
    return encodeOutboundContactOutcome(outcome).ok && !!a.contactReferences && outcome.actionRef===a.contactReferences.outcomeActionRef &&
      isDeepStrictEqual(outcome.scope,a.scope) && outcome.businessId===a.businessId && outcome.credentialFingerprint===a.credentialFingerprint && outcome.patientId===a.patientId &&
      outcome.attempt.recallRef===record.recallRef && outcome.attempt.actionRef===a.actionRef && outcome.attempt.digest===outboundLaunchAttemptDigest(a) &&
      outcome.terminal.endedAt>=a.attemptedAt && outcome.reportedAt>=a.attemptedAt &&
      (outcome.result.kind!=="stopRetained" || outcome.result.decision.actionRef===a.dncReferences?.actionRef);
  } catch { return false; }
}
