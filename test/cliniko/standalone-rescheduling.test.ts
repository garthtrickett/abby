import assert from "node:assert/strict";
import test from "node:test";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { standaloneReschedulingFixture } from "../support/standalone-rescheduling.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { providerRequest } from "../../src/standalone/appointment-change-authority.ts";

async function prepare(f:Awaited<ReturnType<typeof standaloneReschedulingFixture>>) {
  const ref=await f.verify(); resultValue(await f.propose(ref)); resultValue(await f.confirm()); return ref;
}

test("E2E-398 explicit class service replacement cannot project onto an individual in-place move", async () => {
  const f = await standaloneReschedulingFixture();
  try {
    const ref = await f.verify(); resultValue(await f.propose(ref));
    const request = Object.values((await f.state()).actions)[0]!.mutation.request;
    assert.equal(request.kind, "reschedule"); if (request.kind !== "reschedule") throw new Error("missing move");
    assert.ok(providerRequest(request, f.evidence, f.scope));
    assert.equal(providerRequest({ ...request, serviceChange: { fromServiceName: "Mat Pilates" } }, f.evidence, f.scope), undefined);
    assert.equal(f.patches, 0); assert.equal(f.recalls.length, 0);
  } finally { await f.close(); }
});

test("E2E-285 actual email proof, gateway, played old/new/fee confirmation and acknowledged provider review precede one inspected in-place move",async () => {
  const f=await standaloneReschedulingFixture();
  try {
    const ref=await f.verify(), proposed=resultValue(await f.propose(ref));
    const state=await f.state(), action=Object.values(state.actions)[0]!; assert.equal(action.kind,"reschedule");
    const presentation=state.presentations[action.presentationId]!; assert.equal(presentation.kind,"speech");
    if(presentation.kind==="speech") { assert.match(presentation.approvedText,/moving.*to.*No fee applies/); assert.match(presentation.approvedText,/Australian Eastern Daylight/); }
    assert.equal(f.recalls.length,0); assert.equal(f.patches,0); resultValue(await f.confirm()); resultValue(await f.drain());
    assert.equal(f.patches,1); assert.equal(Object.values((await f.state()).actions)[0]!.status,"committed");
    const review=resultValue(decodeClinikoReview(f.recalls[0]!.notes)); assert.equal(review.request.operation.kind,"reschedule");
    if(review.request.operation.kind==="reschedule") assert.deepEqual([review.request.operation.appointmentId,review.request.operation.startsAt,review.request.operation.newStartsAt],
      ["91","2026-10-08T04:00:00.000Z","2026-10-08T05:00:00.000Z"]);
    assert.equal(f.recalls[0]!.recalled,false); assert.equal(resultValue(await f.discovery()).pending.length,1);
    assert.equal(f.traffic.some(path=>path.includes("/cancel") || path.startsWith("DELETE ") || path==="POST /v1/individual_appointments"),false);
    assert.equal(f.claims,f.traffic.length); await f.drain(); assert.equal(f.patches,1);
    for(const secret of [...verificationCanaries,ref,f.mail[0]!.code]) assert.equal(JSON.stringify(proposed).includes(secret),false);
  } finally {await f.close();}
});

test("E2E-285 missing proof, disabled policy, staff support or unplayed affirmation cannot save review or move",async () => {
  for(const cause of ["proof","permission","method","automation","rescheduling","stop","unplayed","callEnd"] as const) {
    const f=await standaloneReschedulingFixture();
    try {
      if(cause==="proof") await f.propose("guessed-proof");
      else {
        const ref=await f.verify();
        if(cause==="permission") f.setPermitted(false);
        if(cause==="method") await f.replaceApproval({enabled:false});
        if(cause==="automation") resultValue(await f.policies.changeAutomationEnabled(f.scope,"1",false,"synthetic-admin"));
        if(cause==="rescheduling") resultValue(await f.policies.changeReschedulingEnabled(f.scope,"1",false,"synthetic-admin"));
        if(cause==="stop") resultValue(await f.ledger.stopWrites(f.scope,"synthetic-admin","stop"));
        if(cause==="callEnd") resultValue(await f.runtime.endCall(f.callId,f.sessionId,verificationNow));
        const proposed=await f.propose(ref); if(cause==="unplayed") {assert.ok(proposed.ok);assert.equal((await f.confirm(false)).ok,false);}
      }
      await f.drain(); assert.equal(f.recalls.length,0);assert.equal(f.patches,0);
    } finally {await f.close();}
  }
  for(const options of [{operation:"appointments.read" as const},{operation:"appointments.cancel" as const},{operation:"appointments.book" as const},{staffWorkEnabled:false}]) {
    const f=await standaloneReschedulingFixture(options);
    try { const ref=await f.verify();await f.propose(ref);await f.drain();assert.equal(f.recalls.length,0);assert.equal(f.patches,0);assert.deepEqual(f.sourceQueries,[]); }
    finally {await f.close();}
  }
});

test("E2E-285 changed target, destination, terms or provider bindings after saved review invalidate the clinical send",async () => {
  for(const cause of ["target","destination","terms","expiry","business","credential","type","practitioner","authority"] as const) {
    const f=await standaloneReschedulingFixture();
    try {
      await prepare(f);f.setOnRecall(async () => {
        if(cause==="target") f.setEvidence({target:{...f.evidence.target,startsAt:"2026-10-08T06:00:00.000Z"}});
        if(cause==="destination" && f.evidence.kind==="reschedule") f.setEvidence({offer:{...f.evidence.offer,startsAt:"2026-10-09T05:00:00.000Z"}});
        if(cause==="terms") f.setEvidence({terms:{...f.evidence.terms,version:"changed"}});
        if(cause==="expiry") f.setEvidence({terms:{...f.evidence.terms,expiresAt:verificationNow}});
        if(cause==="business") f.setEvidence({businessId:"12"}); if(cause==="credential") f.setEvidence({credentialFingerprint:"0".repeat(64)});
        if(cause==="type") f.setEvidence({appointmentTypeId:"34"}); if(cause==="practitioner") f.setEvidence({practitionerId:"23"});
        if(cause==="authority") f.denyAuthority();
      });
      await f.drain(); assert.equal(f.recalls.length,1);assert.equal(f.patches,0,cause);
    } finally {await f.close();}
  }
});

test("E2E-285 late permission, method/member, settings, write stop, lease or close blocks rescheduling",async () => {
  for(const cause of ["permission","method","member","automation","rescheduling","stop","lease","close"] as const) {
    const f=await standaloneReschedulingFixture();
    try {
      await prepare(f);f.setOnRecall(async () => {
        if(cause==="permission") f.setPermitted(false);if(cause==="method") await f.replaceApproval({revision:"changed"});
        if(cause==="member") await f.replaceAccount({membershipVersion:"changed"});
        if(cause==="automation") resultValue(await f.policies.changeAutomationEnabled(f.scope,"1",false,"synthetic-admin"));
        if(cause==="rescheduling") resultValue(await f.policies.changeReschedulingEnabled(f.scope,"1",false,"synthetic-admin"));
        if(cause==="stop") resultValue(await f.ledger.stopWrites(f.scope,"synthetic-admin","stop"));
        if(cause==="lease") f.setTime("2026-10-04T06:01:00.000Z");if(cause==="close") f.host.dispose();
      }); await f.drain(); assert.equal(f.recalls.length,1);assert.equal(f.patches,0,cause);
    } finally {await f.close();}
  }
});

test("E2E-285 lost review or move responses stay unresolved without replay or later exact-commit promotion",async () => {
  for(const lostRecall of [true,false]) {
    const f=await standaloneReschedulingFixture({lostRecall,lostMove:!lostRecall});
    try {
      await prepare(f);await f.drain();assert.equal(f.recalls.length,1);assert.equal(f.patches,lostRecall ? 0 : 1);
      const action=Object.values((await f.state()).actions)[0]!;assert.notEqual(action.status,"committed");
      assert.deepEqual(await f.host.reconcile(action.mutation),{kind:"stillUnknown",actionKey:action.key});
      await f.drain();assert.equal(f.patches,lostRecall ? 0 : 1);assert.equal(resultValue(await f.discovery()).pending.length,1);
    } finally {await f.close();}
  }
});

test("E2E-285 exact moved inspection or conflict failure cannot claim success, undo the move or later upgrade it",async () => {
  for(const cause of ["duration","patient","cancelled","changed","unavailable","malformed","conflict","conflictMalformed","conflictUnavailable"] as const) {
    const f=await standaloneReschedulingFixture();
    try {
      await prepare(f);f.setOnMove(async () => {
        if(cause==="conflict") f.setConflict("present");else if(cause==="conflictMalformed") f.setConflict("malformed");
        else if(cause==="conflictUnavailable") f.setConflict("unavailable");else f.setInspection(cause);
      });await f.drain();assert.equal(f.patches,1);assert.equal(f.recalls.length,1);
      const action=Object.values((await f.state()).actions)[0]!;assert.notEqual(action.status,"committed");
      f.setInspection("exact");f.setConflict("clear");assert.deepEqual(await f.host.reconcile(action.mutation),{kind:"stillUnknown",actionKey:action.key});
      assert.equal(f.traffic.filter(value=>value.startsWith("PATCH ")).length,1);
    } finally {await f.close();}
  }
});

test("E2E-285 permission loss during PATCH prevents protected read-back and success disclosure",async () => {
  const f=await standaloneReschedulingFixture();
  try {
    await prepare(f);f.setOnMove(async () => {f.setPermitted(false);});await f.drain();assert.equal(f.patches,1);
    const writes=f.traffic.lastIndexOf("PATCH /v1/individual_appointments/91");
    assert.equal(f.traffic.slice(writes+1).some(value=>value.startsWith("GET /v1/individual_appointments/")),false);
    assert.notEqual(Object.values((await f.state()).actions)[0]!.status,"committed");
  } finally {await f.close();}
});

test("E2E-285 E2E-286 a final target read or provider budget wait cannot move revocation ahead of PATCH",async () => {
  for(const cause of ["targetRead","budget"] as const) {
    let reservations=0,blocked=false;
    const f=await standaloneReschedulingFixture(cause==="budget" ? {rateBudget:{claim:async () => {reservations++;if(blocked) return {kind:"unavailable"};return null;},observe429:async () => ({kind:"rateLimited"})}} : {});
    try {
      await prepare(f);
      if(cause==="targetRead") f.setOnTarget(async () => {f.setPermitted(false);});
      else f.setOnRecall(async () => {blocked=true;});
      await f.drain();assert.equal(f.recalls.length,1);assert.equal(f.patches,0);
      if(cause==="budget") assert.ok(reservations>0);
    } finally {await f.close();}
  }
});

test("E2E-285 authority revoked during the final conflict response cannot produce a committed receipt",async()=>{
  for(const cause of ["permission","method","rescheduling","stop","lease","close"] as const) {
    const f=await standaloneReschedulingFixture();
    try {
      await prepare(f);f.setOnConflict(async()=>{
        if(cause==="permission") f.setPermitted(false);if(cause==="method") await f.replaceApproval({enabled:false});
        if(cause==="rescheduling") resultValue(await f.policies.changeReschedulingEnabled(f.scope,"1",false,"synthetic-admin"));
        if(cause==="stop") resultValue(await f.ledger.stopWrites(f.scope,"synthetic-admin","stop"));
        if(cause==="lease") f.setTime("2026-10-04T06:01:00.000Z");if(cause==="close") f.host.dispose();
      });await f.drain();assert.equal(f.patches,1);assert.notEqual(Object.values((await f.state()).actions)[0]!.status,"committed",cause);
    } finally {await f.close();}
  }
});
