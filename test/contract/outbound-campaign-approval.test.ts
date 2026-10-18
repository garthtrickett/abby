import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OwnerFileOutboundCampaign } from "../../src/standalone/owner-file-outbound-campaign.ts";
import type { OutboundCampaignApproval } from "../../src/standalone/owner-file-outbound-campaign.ts";
import type { AdminAccount, AdminDirectory } from "../../src/standalone/identity/magic-link.ts";
import { outboundRequestValue } from "../support/outbound-recipient-request.ts";
import { value } from "../support/outbound-records.ts";
async function fixture() {
  const request=outboundRequestValue(),scope=request.scope,folder=await mkdtemp(join(tmpdir(),"abby-outbound-campaign-")),path=join(folder,"campaign.json");
  let now=request.requestedAt,account:AdminAccount|undefined={email:"admin@example.invalid",membershipVersion:"1",actor:{actorRef:"campaign-admin",role:"clinicAdmin",scope}};
  const directory:AdminDirectory={findByEmail:async()=>({ok:true,value:account}),findByRef:async()=>({ok:true,value:account})};
  const approval:OutboundCampaignApproval={scope,revision:"outbound-1",approverRef:"campaign-admin",approvedAt:"2026-11-01T00:00:00.000Z",
    effectiveFrom:"2026-11-01T00:00:00.000Z",effectiveUntil:"2026-11-04T00:00:00.000Z",approved:true,enabled:true,
    campaignRef:request.campaignRef,purpose:request.purpose,providerRef:"synthetic-provider",maximumConcurrent:2,
    audience:{kind:"nativeRecipientRequests",businessId:request.businessId,credentialFingerprint:request.credentialFingerprint,outboundRecallTypeId:"61",recordPolicyDigest:"d".repeat(64)},schedule:request.schedule};
  await writeFile(path,JSON.stringify(approval),{mode:0o600});
  const config={path,scope,directory,clock:()=>now,deadlineMs:300};
  const policy=value(await OwnerFileOutboundCampaign.capture(config,new AbortController().signal));
  const bound={...request,policy:{version:approval.revision,digest:policy.bindingFingerprint()}},selection={scope,...approval.audience};
  const {kind:_kind,...source}=selection;
  return {folder,path,config,policy,approval,request:bound,selection:source,get account(){return account;},setAccount:(a:AdminAccount|undefined)=>{account=a;},setNow:(at:string)=>{now=at;},
    current:(signal=new AbortController().signal)=>policy.currentFor(source,bound,signal),
    replace:async(patch:Record<string,unknown>)=>writeFile(path,JSON.stringify({...approval,...patch})),close:()=>rm(folder,{recursive:true,force:true})};
}
test("current clinic-admin campaign approval binds exact source and request without becoming contact or launch permission",async t=>{
  const f=await fixture();t.after(f.close);const approved=value(await f.current());assert.ok(approved);assert.equal(approved.campaignRef,f.request.campaignRef);
  assert.equal(Object.hasOwn(approved,"patientId"),false);assert.equal(Object.hasOwn(approved,"recipient"),false);assert.equal(Object.hasOwn(approved,"dncAllowed"),false);
  assert.ok(Object.isFrozen(approved)&&Object.isFrozen(approved.audience)&&Object.isFrozen(approved.schedule.weekdays));assert.match(f.policy.bindingFingerprint(),/^[a-f0-9]{64}$/);
  assert.equal(approved.maximumConcurrent,2);assert.equal(approved.providerRef,"synthetic-provider");
});
for(const change of ["disabled","unapproved","fileVersion","fileProvider","memberRole","memberVersion","removed","expired","beforeEffective"] as const)
 test(`current campaign ${change} cannot reuse captured approval`,async t=>{
  const f=await fixture();t.after(f.close);
  if(change==="disabled")await f.replace({enabled:false});if(change==="unapproved")await f.replace({approved:false});
  if(change==="fileVersion")await f.replace({revision:"changed"});if(change==="fileProvider")await f.replace({providerRef:"other"});
  if(change==="memberRole")f.setAccount({...f.account!,actor:{...f.account!.actor,role:"staff"}});
  if(change==="memberVersion")f.setAccount({...f.account!,membershipVersion:"2"});if(change==="removed")f.setAccount(undefined);
  if(change==="expired")f.setNow(f.approval.effectiveUntil);if(change==="beforeEffective")f.setNow("2026-10-31T23:59:59.999Z");
  const found=await f.current();assert.equal(found.ok&&!!found.value,false);
 });
for(const field of ["campaign","purpose","digest","revision","recipientSchedule","sourceType","sourcePolicy","sourceCredential","sourceScope"] as const)
 test(`request or source ${field} mismatch does not borrow campaign approval`,async t=>{
  const f=await fixture();t.after(f.close);let request=f.request,selection=f.selection;
  if(field==="campaign")request={...request,campaignRef:randomUUID()};if(field==="purpose")request={...request,purpose:"sickDay",appointment:{ref:"cliniko:appointment:91",digest:"a".repeat(64)}};
  if(field==="digest")request={...request,policy:{...request.policy,digest:"f".repeat(64)}};if(field==="revision")request={...request,policy:{...request.policy,version:"other"}};
  if(field==="recipientSchedule")request={...request,schedule:{...request.schedule,opensAt:"10:00"}};
  if(field==="sourceType")selection={...selection,outboundRecallTypeId:"62"};if(field==="sourcePolicy")selection={...selection,recordPolicyDigest:"e".repeat(64)};
  if(field==="sourceCredential")selection={...selection,credentialFingerprint:"e".repeat(64)};if(field==="sourceScope")selection={...selection,scope:{...selection.scope,locationId:"other"}};
  assert.deepEqual(await f.policy.currentFor(selection,request,new AbortController().signal),{ok:true,value:undefined});
 });
for(const patch of [{patientId:"21"},{recipient:{number:"+12025550123"}},{dncAllowed:true},{notes:"private context"},{maximumConcurrent:0},{maximumConcurrent:1001},
 {providerRef:""},{campaignRef:"not-random"},{purpose:"marketing"}])test(`expanded or invalid campaign file ${Object.keys(patch)[0]} is refused`,async t=>{
  const f=await fixture();t.after(f.close);await f.replace(patch);assert.equal((await OwnerFileOutboundCampaign.capture(f.config,new AbortController().signal)).ok,false);
 });
test("approval file rejects unsafe permissions, symlinks, oversized or missing data",async t=>{
  const f=await fixture();t.after(f.close);await chmod(f.path,0o644);assert.equal((await OwnerFileOutboundCampaign.capture(f.config,new AbortController().signal)).ok,false);
  await chmod(f.path,0o600);await symlink(f.path,f.path+".link");assert.equal((await OwnerFileOutboundCampaign.capture({...f.config,path:f.path+".link"},new AbortController().signal)).ok,false);
  await writeFile(f.path," ".repeat(8193));assert.equal((await OwnerFileOutboundCampaign.capture(f.config,new AbortController().signal)).ok,false);
});
test("captured directory methods remain bound and replacing them cannot recover revoked real membership",async t=>{
  const f=await fixture();t.after(f.close);const original=f.account;f.setAccount(undefined);
  f.config.directory.findByRef=async()=>({ok:true,value:original});assert.deepEqual(await f.current(),{ok:true,value:undefined});
});
test("held current membership respects cancellation and cannot disclose policy after abort",{timeout:3000},async t=>{
  const f=await fixture();t.after(f.close);let hold=false;const original=f.config.directory.findByRef;
  f.config.directory.findByRef=async ref=>hold?new Promise(()=>{}):original(ref);
  const policy=value(await OwnerFileOutboundCampaign.capture(f.config,new AbortController().signal));hold=true;
  assert.deepEqual(await policy.currentFor(f.selection,f.request,new AbortController().signal),{ok:false,error:{kind:"unavailable"}});
});
