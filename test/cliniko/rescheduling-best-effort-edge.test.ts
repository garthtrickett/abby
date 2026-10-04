import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoRescheduleWriter } from "../../src/cliniko/reschedule-write.ts";
import type { ClinikoRescheduleRequest } from "../../src/cliniko/reschedule-write.ts";

const scope={tenantId:"move-edge",clinicId:"clinic",locationId:"main"},base="https://api.au5.cliniko.com/v1";
const config={scope,apiKey:"synthetic-move-au5",contactEmail:"test@example.test",businessId:"11"};
const query=():ClinikoRescheduleRequest=>({scope:{...scope},patientId:"42",appointmentId:"91",practitionerId:"22",appointmentTypeId:"33",
  startsAt:"2026-10-08T04:00:00.000Z",endsAt:"2026-10-08T04:30:00.000Z",newStartsAt:"2026-10-08T05:00:00.000Z",newEndsAt:"2026-10-08T05:30:00.000Z"});
function appointment(moved=false) {return {id:"91",starts_at:moved?query().newStartsAt:query().startsAt,ends_at:moved?query().newEndsAt:query().endsAt,
  archived_at:null,deleted_at:null,cancelled_at:null,...Object.fromEntries(Object.entries({patient:"patients/42",business:"businesses/11",practitioner:"practitioners/22",appointment_type:"appointment_types/33"})
    .map(([name,path])=>[name,{links:{self:`${base}/${path}`}}]))};}

test("E2E-286 final move authority runs after the old target read and budget wait; false/throw/held/aborted callbacks issue no PATCH",async () => {
  for(const cause of ["false","throw","held","abort"] as const) {
    const order:string[]=[],controller=new AbortController(); let patches=0;
    const adapter=ClinikoRescheduleWriter.create({...config,rateBudget:{claim:async ()=>{order.push("budget");return null;},observe429:async()=>({kind:"rateLimited"})}},
      async (_value,init)=>{if(init?.method==="PATCH") patches++;order.push("GET");return Response.json(appointment());});assert.ok(adapter.ok);
    const pending=adapter.value.rescheduleOnce(query(),controller.signal,{beforeRead:async()=>{order.push("readAuthority");return true;},beforeSend:async()=>{
      order.push("sendAuthority");if(cause==="throw") throw new Error("synthetic failure");
      if(cause==="held") return new Promise<never>(()=>{});if(cause==="abort") controller.abort();return false;
    }});
    if(cause==="held") setTimeout(()=>controller.abort(),25);
    assert.equal((await pending).ok,false);assert.equal(patches,0);assert.deepEqual(order,["budget","readAuthority","GET","budget","sendAuthority"]);
  }
});

test("E2E-286 private inspection authority is checked after every budget wait and a possible move stays uncertain after revocation",async () => {
  for(const denyAt of [1,3,4]) {
    const traffic:string[]=[];let claims=0,permitted=true,moved=false;
    const adapter=ClinikoRescheduleWriter.create({...config,rateBudget:{claim:async()=>{if(++claims===denyAt) permitted=false;return null;},observe429:async()=>({kind:"rateLimited"})}},
      async (value,init)=>{
        const url=new URL(String(value));traffic.push(`${init?.method} ${url.pathname}`);
        if(init?.method==="PATCH") {moved=true;return Response.json({});}
        return url.pathname.endsWith("/conflicts")?Response.json({conflicts:{exist:false}}):Response.json(appointment(moved));
      });assert.ok(adapter.ok);
    const result=await adapter.value.rescheduleOnce(query(),undefined,{beforeSend:async()=>permitted,beforeRead:async()=>permitted});
    if(denyAt===1) {assert.deepEqual(result,{ok:false,error:{kind:"forbidden"}});assert.deepEqual(traffic,[]);}
    else {assert.deepEqual(result,{ok:true,value:{kind:"uncertain"}});assert.equal(traffic.filter(path=>path.startsWith("PATCH")).length,1);
      assert.equal(traffic.length,denyAt-1);assert.equal((await adapter.value.rescheduleOnce(query())).ok,false);}
  }
});

test("E2E-286 false/throw/held/aborted current-state inspection callbacks cannot issue protected HTTP reads",async () => {
  for(const cause of ["false","throw","held","abort"] as const) {
    const stop=new AbortController();let reads=0;
    const adapter=ClinikoRescheduleWriter.create(config,async()=>{reads++;return Response.json(appointment());});assert.ok(adapter.ok);
    const pending=adapter.value.observeReschedule(query(),stop.signal,async()=>{
      if(cause==="throw") throw new Error("synthetic failure");if(cause==="held") return new Promise<never>(()=>{});
      if(cause==="abort") stop.abort();return false;
    });if(cause==="held") setTimeout(()=>stop.abort(),25);
    assert.equal((await pending).ok,false);assert.equal(reads,0);
  }
});

test("E2E-286 the move freezes target, scope, destination and callback functions before an asynchronous budget wait",async () => {
  let entered:()=>void=()=>{},release:()=>void=()=>{},claims=0,moved=false;
  const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  const original=query(),request={...original,scope:{...original.scope}},paths:string[]=[];
  const checks={beforeSend:async()=>true,beforeRead:async()=>true};
  const adapter=ClinikoRescheduleWriter.create({...config,rateBudget:{claim:async()=>{if(++claims===1){entered();await held;}return null;},observe429:async()=>({kind:"rateLimited"})}},
    async(value,init)=>{
      const url=new URL(String(value));paths.push(url.pathname);assert.ok(url.pathname.startsWith("/v1/individual_appointments/91"));
      if(init?.method==="PATCH") {assert.deepEqual(JSON.parse(String(init.body)),{starts_at:original.newStartsAt,ends_at:null});moved=true;return Response.json({});}
      return url.pathname.endsWith("/conflicts")?Response.json({conflicts:{exist:false}}):Response.json(appointment(moved));
    });assert.ok(adapter.ok);
  const pending=adapter.value.rescheduleOnce(request,undefined,checks);await started;
  request.scope.clinicId="foreign";request.patientId="43";request.appointmentId="92";request.newStartsAt="2026-10-09T06:00:00.000Z";checks.beforeSend=async()=>false;
  release();assert.deepEqual(await pending,{ok:true,value:{kind:"moved"}});assert.equal(paths.length,4);
});

test("E2E-286 private callbacks cannot enter a serialized provider request and malformed callback configuration cannot start IO",async()=>{
  let reads=0;const adapter=ClinikoRescheduleWriter.create(config,async()=>{reads++;return Response.json(appointment());});assert.ok(adapter.ok);
  for(const checks of [{beforeSend:async()=>true},{beforeSend:true,beforeRead:async()=>true},null])
    assert.deepEqual(await adapter.value.rescheduleOnce(query(),undefined,checks as never),{ok:false,error:{kind:"invalidQuery"}});
  assert.equal(reads,0);
});
