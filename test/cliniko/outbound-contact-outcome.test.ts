import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { encodeOutboundContactOutcome, decodeOutboundContactOutcome, outboundContactOutcomeDigest, outboundContactOutcomeMatchesAttempt } from "../../src/cliniko/outbound-contact-outcome.ts";
import type { OutboundContactOutcome } from "../../src/cliniko/outbound-contact-outcome.ts";
import { encodeOutboundLaunchAttempt, outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { outboundContactOutcomeValue } from "../support/outbound-contact-outcome.ts";
import { value } from "../support/outbound-records.ts";
for(const stopped of [false,true])test(`native contact outcome canonical ${stopped?"retained stop":"complete no-stop"} evidence remains separately bound`,()=>{
  const {possible,outcome}=outboundContactOutcomeValue(undefined,stopped),notes=value(encodeOutboundContactOutcome(outcome)),decoded=value(decodeOutboundContactOutcome(notes));
  assert.deepEqual(decoded,outcome);assert.ok(Object.isFrozen(decoded)&&Object.isFrozen(decoded.attempt)&&Object.isFrozen(decoded.result)&&Object.isFrozen(decoded.terminal));
  if(decoded.result.kind==="stopRetained")assert.ok(Object.isFrozen(decoded.result.decision));
  assert.equal(outboundContactOutcomeMatchesAttempt(decoded,possible),true);assert.match(outboundContactOutcomeDigest(decoded)!,/^[a-f0-9]{64}$/);assert.ok(notes.length<=1050);
  assert.equal(Object.hasOwn(decoded,"permission"),false);assert.equal(notes.includes("+12025550123"),false);
});
for(const patch of [{actionRef:"bad"},{patientId:"patient-private"},{credentialFingerprint:"bad"},{reportedAt:"2026-02-30T00:00:00.000Z"},{recordedAt:"2026-11-01T09:00:00.000Z"},{permission:true}])
  test(`contact outcome rejects invalid ${Object.keys(patch)[0]}`,()=>{const {outcome}=outboundContactOutcomeValue();assert.equal(encodeOutboundContactOutcome({...outcome,...patch}as OutboundContactOutcome).ok,false);});
test("terminal truth, final contact semantics and retained DNC identity cannot be replaced by booleans or unknown status",()=>{
  const {outcome}=outboundContactOutcomeValue(undefined,true);
  for(const result of [{kind:"unknown",reportDigest:"b".repeat(64)},{kind:"completeNoStop",reportDigest:"b".repeat(64),decision:{}},{kind:"stopRetained",reportDigest:"b".repeat(64)},
    {kind:"stopRetained",reportDigest:"b".repeat(64),decision:{recallRef:outcome.attempt.recallRef,actionRef:randomUUID(),digest:"c".repeat(64)}}])
    assert.equal(encodeOutboundContactOutcome({...outcome,result}as OutboundContactOutcome).ok,false);
  assert.equal(encodeOutboundContactOutcome({...outcome,terminal:{...outcome.terminal,endedAt:"2026-11-01T10:05:00.000Z"}}).ok,false);
});
test("native outcome cannot settle a different original possible attempt or DNC action",()=>{
  const {possible,outcome}=outboundContactOutcomeValue(undefined,true);
  for(const changed of [{...outcome,actionRef:randomUUID()},{...outcome,patientId:"99"},{...outcome,scope:{...outcome.scope,clinicId:"other"}},{...outcome,attempt:{...outcome.attempt,digest:"f".repeat(64)}},
    {...outcome,reportedAt:"2026-11-01T09:00:00.000Z"},
    ...(outcome.result.kind==="stopRetained"?[{...outcome,result:{...outcome.result,decision:{...outcome.result.decision,actionRef:randomUUID()}}}]:[])])
    assert.equal(outboundContactOutcomeMatchesAttempt(changed,possible),false);
});
test("contact outcome rejects alternate encodings, oversized bodies, version aliases and private extra fields",()=>{
  const {outcome}=outboundContactOutcomeValue(),notes=value(encodeOutboundContactOutcome(outcome)),lines=notes.split("\n"),payload=JSON.parse(lines[2]!);
  for(const changed of [notes+"\n",notes.replace("outcome v1","outcome v2"),notes.slice(0,-1),notes.replace(lines[2]!," "+lines[2]),"x".repeat(1051)])assert.equal(decodeOutboundContactOutcome(changed).ok,false);
  for(const bad of [outcome.credentialFingerprint,payload[2]+"=",payload[2].slice(0,-1)+"F"]){const a=structuredClone(payload);a[2]=bad;assert.equal(decodeOutboundContactOutcome([lines[0],lines[1],JSON.stringify(a),lines[3]].join("\n")).ok,false);}
  assert.equal(encodeOutboundContactOutcome({...outcome,number:"+12025550123"}as OutboundContactOutcome).ok,false);
});

test("contact settlement fits every admitted v4 source envelope without copying provider fields",()=>{
  const {possible,outcome}=outboundContactOutcomeValue(undefined,true);let tested=0;
  for(let n=1;n<=96;n++)for(const providerLength of [1,48,96]){
    const attempt={...possible.attempt,requestRecallRef:"cliniko:recall:9999999999999999999",businessId:"9999999999999999999",patientId:"9999999999999999999",scope:{tenantId:"t".repeat(n),clinicId:"c".repeat(n),locationId:"l".repeat(n)},provider:{...possible.attempt.provider,ref:"p".repeat(providerLength)}};
    if(!encodeOutboundLaunchAttempt(attempt).ok)continue;
    const result={...outcome,scope:attempt.scope,businessId:attempt.businessId,patientId:attempt.patientId,attempt:{...outcome.attempt,digest:outboundLaunchAttemptDigest(attempt)!}};
    assert.ok(value(encodeOutboundContactOutcome(result)).length<=1050);tested++;
  }
  assert.ok(tested>100);
  const changed={...possible,attempt:{...possible.attempt,provider:{...possible.attempt.provider,bindingDigest:"f".repeat(64)}}};
  assert.equal(outboundContactOutcomeMatchesAttempt(outcome,changed),false);
});
