import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { err, ok } from "../../src/core/model.ts";
import type { ActionKind, LocationScope, Result } from "../../src/core/model.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { OwnerFileIntakePolicy, intakeRequiredFields, callerMediatedRecoveryText } from "../../src/standalone/owner-file-intake-policy.ts";
import type { IntakeApproval } from "../../src/standalone/owner-file-intake-policy.ts";
import type { BookingApproval } from "../../src/standalone/owner-file-booking-policy.ts";
import type { CancellationApproval } from "../../src/standalone/owner-file-cancellation-policy.ts";
import type { ReschedulingApproval } from "../../src/standalone/owner-file-rescheduling-policy.ts";
import type { CallerVerificationApproval } from "../../src/standalone/owner-file-caller-policy.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { ClinikoBookingSessionConfig } from "../../src/standalone/cliniko-booking-session.ts";
import { approvedSyntheticPolicy } from "../../test/support/approved-voice.ts";
import { ClinikoLifecycleFixture, lifecycleScope as scope, lifecyclePolicyVersion as policyVersion,
  lifecycleDraft, requireLive, LifecycleFailure } from "./cliniko_lifecycle_fixture.ts";
import type { LiveSelection } from "./cliniko_lifecycle_fixture.ts";

export const now = () => new Date().toISOString();
export function value<T>(result: Result<T, {kind:string}>): T {
  if (!result.ok) throw new LifecycleFailure(result.error.kind); return result.value;
}
export type DemoCredentials = {apiKey:string;contactEmail:string};

/** Real SAM and session owners; explicitly synthetic admission, caller turns, mail and playback. */
export async function lifecycleCall(fixture: ClinikoLifecycleFixture, selection: LiveSelection, credentials: DemoCredentials, patientId?: string,
  report:(facts:Record<string,string|boolean|number>)=>void=()=>{}) {
  const folder=await mkdtemp(join(tmpdir(),"abby-live-lifecycle-public-"));
  const lifetime=new AbortController();
  const current=approvedSyntheticPolicy({...referenceDefaultPolicy(scope),policyVersion,automationEnabled:true,
    firstTimeIntakeEnabled:true,firstTimeIntakeVersion:"1",bookingEnabled:true,cancellationEnabled:true,reschedulingEnabled:true,staffWorkEnabled:true,
    capabilities:{book:"execute",cancel:"execute",reschedule:"execute",intake:"execute",transfer:"unavailable"}});
  class Policies extends MemoryPolicyStore {
    override async read(bound: LocationScope) { return isDeepStrictEqual(bound,scope) ? ok(structuredClone(current)) : err({kind:"invalidValue" as const}); }
  }
  const policies=new Policies("requestOnly",now),ledger=new MemoryLedger(async()=>ok(true)),runtime=new CallRuntime(ledger,scope);
  const inbound={key:{accountRef:"synthetic-demo-lifecycle",providerCallRef:`provider-${randomUUID()}`},dialedNumber:"+6125550199",
    presentedCallerNumber:lifecycleDraft.patientPhone,receivedAt:now()},callId=callIdFor(inbound.key),sessionId=`session-${randomUUID()}`;
  let keepalive: ReturnType<typeof setInterval> | undefined, renewing=false, renewal: Promise<void>=Promise.resolve();
  try {
    value(await runtime.admit(callId,current,{key:inbound.key,dialedNumber:inbound.dialedNumber,acceptedAt:now(),deadline:new Date(Date.now()+30000).toISOString()}));
    value(await runtime.activate(callId,sessionId,now()));
    const receipt=value(await ledger.findAdmission(callId)); requireLive(receipt,"admissionMissing");
    const state=async()=>value(await ledger.read(callId,scope));
    keepalive=setInterval(()=>{
      if(renewing || lifetime.signal.aborted) return; renewing=true;
      renewal=(async()=>{ const lease=(await state()).sessionLease; requireLive(lease,"sessionLeaseMissing"); value(await runtime.renewSession(callId,sessionId,lease.version,now())); })()
        .catch(()=>lifetime.abort()).finally(()=>{renewing=false;});
    },10_000);
    const write=async(name:string,data:unknown)=>{const path=join(folder,name+".json");await writeFile(path,JSON.stringify(data),{mode:0o600});return path;};
    const directory=new OwnerFileAdminDirectory(await write("accounts",[{email:"demo-admin@example.test",actor:{actorRef:"synthetic-demo-admin",role:"clinicAdmin",scope},membershipVersion:"demo-member-1"}]),scope);
    const common={scope,revision:"demo-approval-1",approverRef:"synthetic-demo-admin",approvedAt:new Date(Date.now()-60000).toISOString(),
      effectiveFrom:new Date(Date.now()-60000).toISOString(),effectiveUntil:new Date(Date.now()+3600000).toISOString(),approved:true,enabled:true};
    const binding={policyVersion,businessId:selection.businessId,recallTypeId:selection.recallTypeId,
      credentialFingerprint:clinikoCredentialFingerprint(credentials.apiKey),timeZone:selection.timeZone,writeContract:"bestEffort" as const,notificationOwner:"cliniko" as const};
    const booking:BookingApproval={...common,...binding,practitionerId:selection.practitionerId,appointmentTypeId:selection.appointmentTypeId,
      serviceRef:"demo-lifecycle",bookingPolicyVersion:"demo-booking-1",durationMinutes:selection.durationMinutes,minNoticeMinutes:60,maxAdvanceDays:30,offerTtlSeconds:300};
    const terms={lateNoticeHours:24,maxAdvanceDays:30,standardTerms:{version:"demo-standard-1",approvedText:"No fee applies in this synthetic demo rehearsal."},
      lateTerms:{version:"demo-late-1",approvedText:"No fee applies in this synthetic demo rehearsal."}};
    const cancellation:CancellationApproval={...common,...binding,...terms,cancellationReason:50};
    const rescheduling:ReschedulingApproval={...common,...binding,...terms};
    const caller:CallerVerificationApproval={...common,method:"emailOtp",maxAnswers:3,lifetimeSeconds:300,sharedNumbers:"deny",representatives:"deny",
      patientPermission:"independentClinicHost",operations:["appointments.book","appointments.cancel","appointments.reschedule"]};
    const intake:IntakeApproval={...common,policyVersion,intakeVersion:"1",businessId:selection.businessId,credentialFingerprint:binding.credentialFingerprint,
      countryCallingCode:"61",timeZone:selection.timeZone,operation:"patients.intake",callerEligibility:"selfOnly",minors:"deny",representatives:"deny",minimumAgeYears:18,
      leapDayBirthday:"march1",callerPhone:"admittedCallerOnly",verificationMethod:"prospectiveEmailOtp",patientPermission:"independentClinicHost",
      duplicatePolicy:"exactEmailAndBirthDateDenyCandidates",requiredFields:[...intakeRequiredFields],recoveryContract:"callerMediated",
      recoveryTerms:{version:"demo-recovery-1",approvedText:callerMediatedRecoveryText},privacyTerms:{version:"demo-privacy-1",approvedText:"Your registration details will be kept in Cliniko."},
      intakeTerms:{version:"demo-intake-1",approvedText:"Registering your details does not book an appointment."}};
    const callerApprovalPath=await write("caller",caller),bookingApprovalPath=await write("booking",booking),
      cancellationApprovalPath=await write("cancellation",cancellation),reschedulingApprovalPath=await write("rescheduling",rescheduling),intakePath=await write("intake",intake);
    const intakePolicy=value(await OwnerFileIntakePolicy.capture({path:intakePath,scope,policyVersion,intakeVersion:"1",businessId:selection.businessId,
      credentialFingerprint:binding.credentialFingerprint,countryCallingCode:"61",timeZone:selection.timeZone,intakeEnabled:true,directory,clock:now}));
    let code:string|undefined;
    const delivery={send:async(email:string,incoming:string)=>{requireLive(email===lifecycleDraft.email,"unexpectedSyntheticMailbox");code=incoming;return true;}};
    const permission={allows:async(bound:LocationScope,id:string,operation:string)=>isDeepStrictEqual(bound,scope) && id===patientId &&
      ["appointments.book","appointments.cancel","appointments.reschedule"].includes(operation)};
    const config:ClinikoBookingSessionConfig={receipt,inbound,sessionId,policyVersion,ledger,policies,
      lookup:{candidates:async(bound,phone)=>bound.tenantId===scope.tenantId && bound.clinicId===scope.clinicId && phone===lifecycleDraft.patientPhone && patientId ?
        ok({kind:"one",candidateIds:[patientId]}) : ok({kind:"none",candidateIds:[]})},
      permission,verificationBudget:{reserve:async()=>true},delivery,directory,callerApprovalPath,bookingApprovalPath,
      cliniko:{...credentials,...selection,countryCallingCode:"61",rateBudget:fixture.budget},signal:lifetime.signal,fetchPort:fixture.workflowFetch,clock:now};
    const turn=(turnId:string,text="Synthetic caller selection")=>({callId,sessionId,turnId,text,quality:"clear" as const,at:now()});
    async function playPending() {const pending=(await state()).pendingPresentationId;if(!pending) return;
      value(await runtime.startPresentation(callId,pending,sessionId,now()));value(await runtime.resolvePresentation(callId,pending,"played",sessionId,now()));}
    async function finish(reception:TextReception,kind:ActionKind) {
      const action=Object.values((await state()).actions).find(a=>a.kind===kind && a.status==="awaitingConfirmation");requireLive(action,"confirmationActionMissing");
      await playPending();value(await reception.affirm(scope,turn(`affirm-${randomUUID()}`,"Yes"),action.key,action.digest,now()));
      const began=Date.now();value(await reception.drain(scope,callId,now()));
      const final=(await state()).actions[action.key];report({kind,durationMs:Date.now()-began,callAborted:lifetime.signal.aborted,status:final?.status ?? "missing",...fixture.counts});
      requireLive(final?.status==="committed",`action_${kind}_${final?.status ?? "missing"}`);
      const sent=structuredClone(fixture.counts);value(await reception.drain(scope,callId,now()));requireLive(isDeepStrictEqual(sent,fixture.counts),"drainRepeatedMutation");
      await playPending();return final;
    }
    const agentFor=(reception:TextReception)=>new CommandGateway({actorRef:"synthetic-trusted-agent",role:"agent",scope},policies,reception,undefined,undefined,undefined,ledger);
    async function verify(owner:{beginVerification():unknown;submitCode(code:string):Promise<{verified:boolean}>;verified():Promise<{verificationRef:string}|undefined>}) {
      owner.beginVerification();const until=Date.now()+15000;
      while(!code && Date.now()<until && !lifetime.signal.aborted) await new Promise<void>(resolve=>setTimeout(resolve,10));
      requireLive(code,"syntheticOtpNotIssued"); requireLive((await owner.submitCode(code)).verified,"syntheticOtpRejected");
      const grant=await owner.verified();requireLive(grant,"verificationGrantMissing");return grant.verificationRef;
    }
    await playPending();
    return {scope,config,ledger,policies,runtime,receipt,lifetime,inbound,sessionId,callId,directory,intakePolicy,cancellationApprovalPath,reschedulingApprovalPath,
      state,turn,playPending,finish,agentFor,verify,code:()=>code,
      close:async()=>{if(keepalive)clearInterval(keepalive);await renewal;lifetime.abort();await runtime.endCall(callId,sessionId,now());await rm(folder,{recursive:true,force:true});}};
  } catch(error) {if(keepalive)clearInterval(keepalive);await renewal;lifetime.abort();await rm(folder,{recursive:true,force:true});throw error;}
}
