import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClinikoLifecycleFixture, lifecycleDraft, lifecycleTypeName } from "../../phase-0/probes/cliniko_lifecycle_fixture.ts";
import type { Row } from "../../phase-0/probes/cliniko_lifecycle_fixture.ts";
import { runClinikoLifecycle } from "../../phase-0/probes/cliniko_lifecycle_rehearsal.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";

/** Stateful remote double for the actual session/SAM/probe compositions, including provider-owned recovery. */
function provider() {
  const base="https://api.au5.cliniko.com/v1", records=new Map<string,Row>(), traffic:{method:string;path:string}[]=[];
  let next=40,failBooking=false,loseBooking=false,editPatient=false,editDuringArchive=false;
  const stamp=()=>new Date(Date.now()+next++).toISOString();
  records.set("businesses/11",{id:"11",updated_at:stamp(),archived_at:null,show_in_online_bookings:false,time_zone_identifier:"Australia/Sydney",appointment_type_ids:["33"]});
  records.set("practitioners/22",{id:"22",active:true,show_in_online_bookings:true,display_name:"Demo Practitioner"});
  records.set("appointment_types/33",{id:"33",archived_at:null,show_in_online_bookings:true,name:"Demo service",duration_in_minutes:30});
  const link=(resource:string,id:string)=>({links:{self:`${base}/${resource}/${id}`}});
  const fetchPort:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)),path=url.pathname.slice(4),method=init?.method??"GET",body=init?.body?JSON.parse(String(init.body)):{};
    traffic.push({method,path});assert.equal(url.origin,new URL(base).origin);assert.equal(init?.redirect,"error");
    if(!path.startsWith("individual_appointments") && url.searchParams.getAll("q[]").some(q=>q.startsWith("cancelled_at:"))) return new Response(null,{status:400});
    if(path==="recalls" && url.searchParams.getAll("q[]").some(q=>q.startsWith("recall_type_id:"))) return new Response(null,{status:400});
    if(method==="GET" && path.endsWith("/available_times")) {
      const day=url.searchParams.get("from")!;
      const offered=["04:00","05:00","06:00"].map(time=>`${day}T${time}:00.000Z`).filter(start=>
        ![...records].some(([key,r])=>key.startsWith("individual_appointments/") && !r.archived_at && !r.cancelled_at && r.starts_at===start));
      return Response.json({total_entries:offered.length,available_times:offered.map(appointment_start=>({appointment_start}))});
    }
    if(method==="GET" && path.endsWith("/conflicts")) return Response.json({conflicts:{exist:false}});
    if(method==="POST" && path.endsWith("/archive")) {
      const record=records.get(path.slice(0,-8));assert.ok(record);
      if(path.startsWith("individual_appointments/") && record.cancelled_at &&
        !url.searchParams.getAll("q[]").includes("cancelled_at:*")) return new Response(null,{status:404});
      record.archived_at=stamp();
      if(path.startsWith("individual_appointments/")) {
        const patient=records.get(`patients/${record.patient_id}`);assert.ok(patient);patient.updated_at=stamp();
        if(editDuringArchive)patient.notes="Staff added work during cleanup";
      }
      return new Response(null,{status:204});
    }
    if(method==="PATCH") {
      const record=records.get(path.replace(/\/cancel$/,""));assert.ok(record);
      Object.assign(record,body,{updated_at:stamp()});
      if(path.endsWith("/cancel")) {record.cancelled_at=stamp();return new Response(null,{status:204});}
      if(path.startsWith("individual_appointments/")) record.ends_at=new Date(Date.parse(body.starts_at)+1800000).toISOString();
      return Response.json(record);
    }
    if(method==="POST") {
      if(path==="individual_appointments" && failBooking) return new Response(null,{status:422});
      const id=String(next++),record:Row={...body,id,updated_at:stamp(),archived_at:null};
      if(path==="patients") Object.assign(record,{notes:"",appointment_notes:"",old_reference_id:""});
      if(path==="recalls") Object.assign(record,{recalled:false,recalled_at:null,patient:link("patients",body.patient_id),recall_type:link("recall_types",body.recall_type_id)});
      if(path==="individual_appointments") Object.assign(record,{cancelled_at:null,deleted_at:null,ends_at:new Date(Date.parse(body.starts_at)+1800000).toISOString(),
        patient:link("patients",body.patient_id),business:link("businesses",body.business_id),practitioner:link("practitioners",body.practitioner_id),appointment_type:link("appointment_types",body.appointment_type_id)});
      records.set(`${path}/${id}`,record);
      if(path==="individual_appointments" && loseBooking) throw new Error("completed synthetic POST response lost");
      return Response.json(record,{status:201});
    }
    assert.equal(method,"GET");
    if(records.has(path)) return Response.json(records.get(path));
    if(path==="businesses/11/practitioners") return Response.json({total_entries:1,practitioners:[{id:"22"}]});
    if(path==="practitioners/22/appointment_types") return Response.json({total_entries:1,appointment_types:[{id:"33"}]});
    const resource=path.split("/").at(-1)!;
    let entries=[...records].filter(([key,r])=>key.startsWith(resource+"/") && !r.archived_at).map(([,r])=>r);
    for(const query of url.searchParams.getAll("q[]")) {
      const separator=query.indexOf(":"),field=query.slice(0,separator),filter=query.slice(separator+1);
      if(filter==="*") continue;
      if(filter.startsWith(">=") || filter.startsWith("<=")) {
        const at=Date.parse(filter.slice(2));entries=entries.filter(r=>filter.startsWith(">=")?Date.parse(String(r[field]))>=at:Date.parse(String(r[field]))<=at);continue;
      }
      if(filter.startsWith(">") || filter.startsWith("<")) {
        const at=Date.parse(filter.slice(1));entries=entries.filter(r=>filter.startsWith(">")?Date.parse(String(r[field]))>at:Date.parse(String(r[field]))<at);continue;
      }
      const target=filter.slice(1);
      entries=entries.filter(r=>field==="patient_id"?r.patient_id===target:field==="recall_type_id"?r.recall_type_id===target:r[field!]===target);
    }
    if(resource==="individual_appointments" && !url.searchParams.getAll("q[]").includes("cancelled_at:*")) entries=entries.filter(r=>!r.cancelled_at);
    if(editPatient && resource==="patients" && entries.length) entries[0]!.notes="Staff changed this record";
    entries.sort((a,b)=>Number(a.id)-Number(b.id));
    return Response.json({total_entries:entries.length,[resource]:entries});
  };
  return {fetchPort,records,traffic,failBooking:()=>{failBooking=true;},loseBooking:()=>{loseBooking=true;},editPatient:()=>{editPatient=true;},editDuringArchive:()=>{editDuringArchive=true;}};
}
async function fixture() {
  const p=provider(),folder=await mkdtemp(join(tmpdir(),"abby-lifecycle-test-")),recoveryFile=join(folder,"public.json"),credentials={apiKey:"synthetic-live-au5",contactEmail:"demo@example.test"};
  let budgetTime=Date.now();const budget=new ClinikoReadBudget(180,()=>budgetTime);
  const f=new ClinikoLifecycleFixture({...credentials,recoveryFile},p.fetchPort,{budget,cooldown:async()=>{budgetTime+=61_000;}});
  return {p,f,credentials,recoveryFile,close:()=>rm(folder,{recursive:true,force:true})};
}
test("E2E-305 actual admitted lifecycle confirms intake/book/move/cancel and repeat drain sends once",async()=>{
  const f=await fixture(),steps:string[]=[];
  try {
    const result=await runClinikoLifecycle(f.f,f.credentials,step=>steps.push(step));
    assert.deepEqual(result,{ok:true,cleanup:true,intake:1,book:2,reschedule:1,cancel:1,recall:4});
    assert.deepEqual(steps.filter(s=>!["providerBudgetCooldown","bookingMenuStarted","bookingSelectionStarted","bookingConfirmationStarted","dispatch"].includes(s)),["prepared","intake","intakeBooking","rescheduling","cancellation","existingPatientBooking","cleanup"]);
    assert.equal(f.p.records.get("businesses/11")!.show_in_online_bookings,false);
    assert.ok([...f.p.records].filter(([key])=>/^(patients|recalls|recall_types|individual_appointments)\//.test(key)).every(([,record])=>record.archived_at));
    await assert.rejects(access(f.recoveryFile));
  } finally {await f.close();}
});
test("lifecycle unknown/rejected booking fails truthfully and cleans provider-owned intake/review",async()=>{
  const f=await fixture();f.p.failBooking();
  try {
    await assert.rejects(runClinikoLifecycle(f.f,f.credentials,()=>{}),/action_book_uncertain/);
    assert.equal(f.f.counts.intake,1);assert.equal(f.f.counts.book,1);assert.equal(f.f.counts.reschedule,0);
    assert.equal(f.p.records.get("businesses/11")!.show_in_online_bookings,false);
    assert.ok([...f.p.records].filter(([key])=>key.startsWith("patients/") || key.startsWith("recalls/")).every(([,r])=>r.archived_at));
  } finally {await f.close();}
});
test("lifecycle lost completed booking response never replays and discovers exactly one fixture for cleanup",async()=>{
  const f=await fixture();f.p.loseBooking();
  try {
    await assert.rejects(runClinikoLifecycle(f.f,f.credentials,()=>{}),/action_book_uncertain/);
    assert.equal(f.f.counts.book,1);
    const appointments=[...f.p.records].filter(([key])=>key.startsWith("individual_appointments/"));
    assert.equal(appointments.length,1);assert.ok(appointments[0]![1].archived_at);
    assert.equal(f.p.records.get("businesses/11")!.show_in_online_bookings,false);
  } finally {await f.close();}
});
test("lifecycle cleanup refreshes provider-managed patient revisions but preserves clinical edits after child archive",async()=>{
  const f=await fixture();f.p.editDuringArchive();
  try {
    await assert.rejects(runClinikoLifecycle(f.f,f.credentials,()=>{}),/patientEditedDuringCleanup/);
    const patient=[...f.p.records].find(([key])=>key.startsWith("patients/"))![1];
    assert.equal(patient.archived_at,null);assert.equal(patient.notes,"Staff added work during cleanup");
    assert.equal(f.f.businessRestored,true);assert.equal(f.p.records.get("businesses/11")!.show_in_online_bookings,false);
  } finally {await f.close();}
});
test("lifecycle refuses foreign mutation before network or send counter",async()=>{
  const f=await fixture();
  try {
    await assert.rejects(f.f.workflowFetch("https://api.au5.cliniko.com/v1/individual_appointments/999/cancel",{method:"PATCH",redirect:"error",body:'{"cancellation_reason":50}'}),/unsafeChangeSend/);
    await assert.rejects(f.f.workflowFetch("https://api.au5.cliniko.com/v1/patients",{method:"POST",redirect:"error",body:'{"first_name":"Real"}'}),/unsafeIntakeSend/);
    assert.equal(f.p.traffic.length,0);assert.equal(f.f.counts.intake,0);assert.equal(f.f.counts.cancel,0);
  } finally {await f.close();}
});
test("lifecycle recovery file contains only public settings and survives a new cleanup process owner",async()=>{
  const f=await fixture();
  try {
    await f.f.prepare();const stored=JSON.parse(await readFile(f.recoveryFile,"utf8"));
    assert.deepEqual(Object.keys(stored).sort(),["businessId","expectedUpdatedAt","originalOnline","state"]);
    const reopened=new ClinikoLifecycleFixture({...f.credentials,recoveryFile:f.recoveryFile},f.p.fetchPort);
    await reopened.cleanup();assert.equal(f.p.records.get("businesses/11")!.show_in_online_bookings,false);
    assert.equal([...f.p.records.values()].filter(r=>r.name===lifecycleTypeName && !r.archived_at).length,0);
  } finally {await f.close();}
});
test("lifecycle refuses clinical edits during cleanup while restoring the owned business flag",async()=>{
  const f=await fixture();
  try {
    await f.f.prepare();
    f.p.records.set("patients/999",{id:"999",first_name:lifecycleDraft.firstName,last_name:lifecycleDraft.lastName,email:lifecycleDraft.email,date_of_birth:lifecycleDraft.dateOfBirth,
      patient_phone_numbers:[{number:lifecycleDraft.patientPhone,phone_type:"Mobile"}],archived_at:null,notes:"Staff work"});
    await assert.rejects(f.f.cleanup(),/ambiguousFixtureCleanup/);
    assert.equal(f.p.records.get("patients/999")!.archived_at,null);assert.equal(f.p.records.get("businesses/11")!.show_in_online_bookings,false);
  } finally {await f.close();}
});
test("lifecycle rejected setup cannot clean another run's existing fixture",async()=>{
  const f=await fixture();
  try {
    f.p.records.set("patients/999",{id:"999",email:lifecycleDraft.email,archived_at:null,notes:"Preserve existing work"});
    await assert.rejects(runClinikoLifecycle(f.f,f.credentials,()=>{}),/existingFixtureRequiresCleanup/);
    assert.equal(f.f.ownsRun,false);assert.equal(f.p.records.get("patients/999")!.archived_at,null);
    assert.ok(f.p.traffic.every(t=>t.method==="GET"));
  } finally {await f.close();}
});
test("lifecycle refuses to overwrite an independently edited business during restore",async()=>{
  const f=await fixture();
  try {
    await f.f.prepare();const business=f.p.records.get("businesses/11")!;
    business.updated_at="2026-01-01T00:00:00.000Z";
    await assert.rejects(f.f.restoreBusiness(),/businessEditedBeforeRestore/);
    assert.equal(business.show_in_online_bookings,true);await access(f.recoveryFile);
  } finally {await f.close();}
});
test("lifecycle preserves an originally enabled business and refuses a second checkpoint claimant",async()=>{
  const f=await fixture();
  try {
    f.p.records.get("businesses/11")!.show_in_online_bookings=true;
    await f.f.prepare();assert.equal(f.f.businessTemporarilyEnabled,false);
    const another=new ClinikoLifecycleFixture({...f.credentials,recoveryFile:f.recoveryFile},f.p.fetchPort);
    await assert.rejects(another.prepare(),/existingFixtureRequiresCleanup/);assert.equal(another.ownsRun,false);
    await f.f.cleanup();assert.equal(f.f.businessRestored,true);
    assert.equal(f.p.records.get("businesses/11")!.show_in_online_bookings,true);
    assert.ok(!f.p.traffic.some(t=>t.path==="businesses/11" && t.method==="PATCH"));
  } finally {await f.close();}
});
