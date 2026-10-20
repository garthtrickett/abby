import assert from "node:assert/strict";
import { ClinikoCancellationWriter } from "../../src/cliniko/cancellation-write.ts";
import { ClinikoRescheduleWriter } from "../../src/cliniko/reschedule-write.ts";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { ClinikoRecallWriter } from "../../src/cliniko/recall-write.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { ClinikoVerificationContactReader } from "../../src/cliniko/verification-contact.ts";
import type { LocationScope } from "../../src/core/model.ts";
import { err, ok } from "../../src/core/model.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import type { AppointmentChangeAuthority } from "../../src/standalone/appointment-change-authority.ts";
import type { ClinikoReschedulingAuthorityConfig } from "../../src/standalone/cliniko-rescheduling-authority.ts";
import type { AppointmentChangeAuthorityEvidence } from "../../src/standalone/appointment-change-authority.ts";
import { CallerVerificationSession } from "../../src/standalone/caller-verification-session.ts";
import { ClinikoReschedulingHost } from "../../src/standalone/cliniko-rescheduling-host.ts";
import type { PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import type { PatientOperation } from "../../src/standalone/transient-patient-proof.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { callerVerificationFixture, verificationCanaries, verificationNow } from "./caller-verification.ts";

/** Actual verifier/SAM/gateway/review/move adapters; clinical authority, mail and provider are synthetic. */
export async function standaloneReschedulingFixture(options: { scope?: LocationScope; folder?: string; operation?: PatientOperation;
  verificationBudget?: PatientVerificationBudget; rateBudget?: ClinikoRequestBudget; fetchPort?: typeof fetch;
  fetchAround?: (port: typeof fetch) => typeof fetch;
  authorityFor?: (config: Omit<ClinikoReschedulingAuthorityConfig, "policy" | "feePolicy">, port: typeof fetch) => Promise<AppointmentChangeAuthority>;
  staffWorkEnabled?: boolean; lostRecall?: boolean; lostMove?: boolean; cancellationExecute?: boolean; destinationPractitionerId?: string; sameTime?: boolean;
  practitionerChoices?: readonly string[] } = {}) {
  const f = await callerVerificationFixture({ operation: options.operation ?? "appointments.reschedule", reschedulingExecute:true,
    ...(options.cancellationExecute ? { cancellationExecute: true } : {}),
    ...(options.scope ? { scope:options.scope } : {}), ...(options.folder ? { folder:options.folder } : {}),
    ...(options.staffWorkEnabled === undefined ? {} : { staffWorkEnabled:options.staffWorkEnabled }) });
  f.session.dispose();
  const apiKey = "synthetic-session-au5", base = "https://api.au5.cliniko.com/v1", traffic:string[] = [], sourceQueries:string[] = [];
  const mail:{email:string;code:string}[] = [], recalls:Record<string,unknown>[] = [];
  let patches = 0, claims = 0, moved = false, inspected = "exact", conflict = "clear", authorityPermitted = true;
  let appliedPractitioner = "22";
  let onRecall = async () => {}, onMove = async () => {}, onTarget = async () => {}, onConflict = async () => {};
  let host:ClinikoReschedulingHost | undefined, session:CallerVerificationSession | undefined;
  let evidence:AppointmentChangeAuthorityEvidence = { kind:"reschedule", scope:f.scope, callId:f.callId, sessionId:f.sessionId,
    policyVersion:f.sessionConfig.policyVersion, patientId:verificationCanaries[2]!, targetRef:"approved-target", businessId:"11",
    credentialFingerprint:clinikoCredentialFingerprint(apiKey), practitionerId:"22", appointmentTypeId:"33",
    target:{scope:f.scope,patientRef:verificationCanaries[2]!,appointmentRef:"91",startsAt:"2026-10-08T04:00:00.000Z",endsAt:"2026-10-08T04:30:00.000Z",timeZone:"Australia/Sydney"},
    terms:{version:"move-fee-1",approvedText:"No fee applies to this move.",expiresAt:"2026-10-04T06:04:00.000Z"},
    offer:{scope:f.scope,offerRef:"approved-offer",serviceRef:"physiotherapy",startsAt:"2026-10-08T05:00:00.000Z",expiresAt:"2026-10-04T06:04:00.000Z"} };
  const newStart = options.sameTime ? "2026-10-08T04:00:00.000Z" : "2026-10-08T05:00:00.000Z";
  const providerAppointment = () => ({ id:"91",starts_at:moved ? newStart : "2026-10-08T04:00:00.000Z",
    ends_at:moved ? new Date(Date.parse(newStart) + 1_800_000).toISOString() : "2026-10-08T04:30:00.000Z",cancelled_at:null,archived_at:null,deleted_at:null,
    patient:{links:{self:`${base}/patients/${verificationCanaries[2]}`}},business:{links:{self:`${base}/businesses/11`}},
    practitioner:{links:{self:`${base}/practitioners/${moved ? appliedPractitioner : "22"}`}},appointment_type:{links:{self:`${base}/appointment_types/33`}},notes:verificationCanaries[1] });
  const fakeProvider:typeof fetch = async (value,init) => {
    const url=new URL(String(value)), method=init?.method ?? "GET";
    if (url.pathname.startsWith("/v1/patients/")) return Response.json({ id:verificationCanaries[2],email:verificationCanaries[0],archived_at:null,
      patient_phone_numbers:[{number:"+61400111222",phone_type:"Mobile"}],notes:verificationCanaries[1] });
    if (url.pathname === "/v1/recalls") {
      if (method === "GET") return Response.json({recalls,total_entries:recalls.length});
      assert.equal(method,"POST"); const body=JSON.parse(String(init?.body));
      const row={id:"71",archived_at:null,recalled:false,recall_at:body.recall_at,notes:body.notes,
        patient:{links:{self:`${base}/patients/${verificationCanaries[2]}`}},recall_type:{links:{self:`${base}/recall_types/7`}}};
      recalls.push(row); await onRecall(); if(options.lostRecall) throw new Error("synthetic lost recall response");
      return Response.json(row,{status:201});
    }
    if(url.pathname.endsWith("/conflicts")) {
      await onConflict(); if(conflict==="unavailable") return new Response(null,{status:503});
      return Response.json({conflicts:{exist:conflict==="malformed" ? "false" : conflict==="present"}});
    }
    assert.equal(url.pathname,"/v1/individual_appointments/91");
    if(method==="PATCH") {
      assert.equal(recalls.length,1); const state=await f.state(), action=Object.values(state.actions)[0]!;
      assert.equal(action.status,"dispatched"); assert.equal(state.presentations[action.presentationId]?.status,"played");
      const body = JSON.parse(String(init?.body));
      if (options.practitionerChoices !== undefined) {
        assert.deepEqual(body, { starts_at: newStart, ends_at: null, ...(body.practitioner_id === undefined ? {} : { practitioner_id: body.practitioner_id }) });
        if (body.practitioner_id !== undefined) assert.ok(options.practitionerChoices.includes(body.practitioner_id));
      } else assert.deepEqual(body,{starts_at:newStart,ends_at:null, ...(options.destinationPractitionerId ? { practitioner_id: options.destinationPractitionerId } : {})});
      appliedPractitioner = body.practitioner_id ?? "22";
      patches++; moved=true; await onMove(); if(options.lostMove) throw new Error("synthetic lost move response");
      return Response.json(providerAppointment());
    }
    assert.equal(method,"GET"); await onTarget();
    if(inspected==="unavailable") return new Response(null,{status:503});
    if(inspected==="malformed") return Response.json({id:"91"});
    const row:Record<string,unknown>=providerAppointment();
    if(inspected==="duration") row.ends_at="2026-10-08T05:45:00.000Z";
    if(inspected==="patient") row.patient={links:{self:`${base}/patients/43`}};
    if(inspected==="cancelled") row.cancelled_at=verificationNow;
    if(inspected==="changed") row.starts_at="2026-10-09T06:00:00.000Z";
    return Response.json(row);
  };
  const innerFetch = options.fetchAround ? options.fetchAround(options.fetchPort ?? fakeProvider) : options.fetchPort ?? fakeProvider;
  const fetchPort:typeof fetch=async (value,init) => {
    const url=new URL(String(value)); assert.equal(url.origin,"https://api.au5.cliniko.com"); assert.equal(init?.redirect,"error");
    traffic.push(`${init?.method ?? "GET"} ${url.pathname}`); return innerFetch(value,init);
  };
  const rateBudget=options.rateBudget ?? {claim:async () => { claims++; return null; },observe429:async () => ({kind:"rateLimited" as const})};
  try {
    const provider={scope:f.scope,apiKey,contactEmail:"test@example.test",businessId:"11",rateBudget};
    session=resultValue(CallerVerificationSession.create({...f.sessionConfig,
      contact:new ClinikoVerificationContactReader({...provider,countryCallingCode:"61"},fetchPort),budget:options.verificationBudget ?? {reserve:async () => true},
      delivery:{send:async (email,code) => { mail.push({email,code}); return true; }} }));
    const authority = options.authorityFor ? await options.authorityFor({ ...provider, practitionerId:"22", appointmentTypeId:"33",
      callId:f.callId,sessionId:f.sessionId,policyVersion:f.sessionConfig.policyVersion,proof:session.proof,clock:f.sessionConfig.clock }, fetchPort) :
      {resolve:async (query: Parameters<AppointmentChangeAuthority["resolve"]>[0]) => { sourceQueries.push(query.phase); return authorityPermitted ? ok(structuredClone(evidence)) : err({kind:"unavailable" as const,target:"appointment" as const}); }};
    host=new ClinikoReschedulingHost({ scope:f.scope,callId:f.callId,sessionId:f.sessionId,policyVersion:f.sessionConfig.policyVersion,
      businessId:"11",credentialFingerprint:clinikoCredentialFingerprint(apiKey),ledger:f.ledger,policy:f.policies,proof:session.proof,
      authority,
      cancellation:resultValue(ClinikoCancellationWriter.create(provider,fetchPort,f.sessionConfig.clock)),
      rescheduling:resultValue(ClinikoRescheduleWriter.create(provider,fetchPort,f.sessionConfig.clock)),
      recallWriter:resultValue(ClinikoRecallWriter.create(provider,fetchPort)),recallTypeId:"7",timeZone:"Australia/Sydney",clock:f.sessionConfig.clock });
    const reception=new TextReception(f.ledger,f.policies,host), agent=new CommandGateway({actorRef:"trusted-agent",role:"agent",scope:f.scope},f.policies,reception);
    const turn=(turnId:string,text="Move my appointment") => ({callId:f.callId,sessionId:f.sessionId,turnId,text,quality:"clear" as const,at:verificationNow});
    async function verify() {
      session!.begin(); const deadline=Date.now()+5000;
      while(!mail.length && Date.now()<deadline) await new Promise<void>(resolve => setTimeout(resolve,5));
      assert.ok(mail[0]); assert.equal((await session!.submitCode(mail[0].code)).verified,true);
      const grant=await session!.verified(); assert.ok(grant); return grant.verificationRef;
    }
    async function confirm(played=true) {
      const action=Object.values((await f.state()).actions)[0]; assert.ok(action,"proposal must create a SAM move action");
      if(played) { resultValue(await f.runtime.startPresentation(f.callId,action.presentationId,f.sessionId,verificationNow));
        resultValue(await f.runtime.resolvePresentation(f.callId,action.presentationId,"played",f.sessionId,verificationNow)); }
      return reception.affirm(f.scope,turn("affirm","Yes"),action.key,action.digest,verificationNow);
    }
    return {...f,host,session,agent,reception,mail,traffic,recalls,sourceQueries,turn,verify,confirm,
      propose:(verificationRef:string,turnId="proposal",targetRef="approved-target",offerRef="approved-offer") => agent.submit({kind:"appointments.change.propose.v1",turn:turn(turnId),selection:{kind:"reschedule",verificationRef,targetRef,offerRef},now:verificationNow}),
      drain:() => reception.drain(f.scope,f.callId,verificationNow), discovery:() => resultValue(ClinikoRecallReader.create(provider,fetchPort)).discoverPendingReviews(f.scope,"7"),
      get evidence() {return evidence;}, setEvidence:(patch:Partial<AppointmentChangeAuthorityEvidence>) => {evidence={...evidence,...patch} as AppointmentChangeAuthorityEvidence;},
      denyAuthority:() => {authorityPermitted=false;},setInspection:(value:string) => {inspected=value;},setConflict:(value:string) => {conflict=value;},
      setOnRecall:(run:() => Promise<void>) => {onRecall=run;},setOnMove:(run:() => Promise<void>) => {onMove=run;},
      setOnTarget:(run:() => Promise<void>) => {onTarget=run;},setOnConflict:(run:() => Promise<void>) => {onConflict=run;},
      get patches() {return patches;},get claims() {return claims;}, close:async () => {host?.dispose();session?.dispose();await f.close();} };
  } catch(error) { host?.dispose();session?.dispose();await f.close();throw error; }
}
