import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { encodeOutboundLaunchAttempt,decodeOutboundLaunchAttempt,outboundAttemptMatchesRequest,outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { outboundLaunchValue } from "../support/outbound-launch.ts";
import { value } from "../support/outbound-records.ts";
test("canonical possible launch binds exact original request but proves no launched call",()=>{
  const {request,attempt}=outboundLaunchValue(),notes=value(encodeOutboundLaunchAttempt(attempt)),decoded=value(decodeOutboundLaunchAttempt(notes));
  assert.deepEqual(decoded,attempt);assert.ok(Object.isFrozen(decoded)&&Object.isFrozen(decoded.scope)&&Object.isFrozen(decoded.provider));assert.equal(outboundAttemptMatchesRequest(decoded,request,attempt.requestRecallRef),true);
  assert.match(outboundLaunchAttemptDigest(attempt)!,/^[a-f0-9]{64}$/);assert.equal(notes.includes(request.recipient.number),false);assert.equal(Object.hasOwn(decoded,"providerCallId"),false);
});
for(const patch of [{actionRef:"bad"},{requestRecallRef:"cliniko:appointment:30"},{requestDigest:"bad"},{dispatchNotAfter:"2026-11-01T10:00:00.000Z"},
 {attemptedAt:"2026-02-30T00:00:00.000Z"},{provider:{ref:"x",bindingDigest:"bad"}},{launched:true},{terminal:true},{recipient:{number:"+12025550123"}}])
 test(`possible-attempt ${Object.keys(patch)[0]} cannot invent authority or an invalid binding`,()=>{
  const {attempt}=outboundLaunchValue();assert.equal(encodeOutboundLaunchAttempt({...attempt,...patch} as typeof attempt).ok,false);
 });
for(const field of ["requestActionRef","campaignRef","approvalRef","effectRef"] as const)test(`possible-attempt record action cannot alias ${field}`,()=>{
  const {attempt}=outboundLaunchValue();assert.equal(encodeOutboundLaunchAttempt({...attempt,actionRef:attempt[field]}).ok,false);
});
for(const field of ["actionRef","recipient","purpose","policy","target"] as const)test(`changed original request ${field} does not reuse possible evidence`,()=>{
  const {attempt,request}=outboundLaunchValue();const changed={...request,...(field==="actionRef"?{actionRef:randomUUID()}:field==="recipient"?{recipient:{kind:"voice" as const,number:"+12025550124"}}:field==="purpose"?{purpose:"sickDay" as const,appointment:{ref:"cliniko:appointment:91",digest:"a".repeat(64)}}:field==="policy"?{policy:{...request.policy,digest:"f".repeat(64)}}:{appointment:{ref:"cliniko:appointment:92",digest:"c".repeat(64)}})};
  assert.equal(outboundAttemptMatchesRequest(attempt,changed,attempt.requestRecallRef),false);
});
test("parser rejects noncanonical notes and older or foreign record families",()=>{
  const {attempt}=outboundLaunchValue(),notes=value(encodeOutboundLaunchAttempt(attempt));
  for(const changed of [notes+"\n",notes.replace("launch v1","launch v2"),notes.replace("Possible attempt only.","Launched successfully."),notes.replace('["cliniko:recall:30"','[ "cliniko:recall:30"')])assert.equal(decodeOutboundLaunchAttempt(changed).ok,false);
});
