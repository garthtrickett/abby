import { isDeepStrictEqual } from "node:util";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ClinikoBookingSession } from "../../src/standalone/cliniko-booking-session.ts";
import { ClinikoCancellationSession } from "../../src/standalone/cliniko-cancellation-session.ts";
import { ClinikoReschedulingSession } from "../../src/standalone/cliniko-rescheduling-session.ts";
import { ClinikoIntakeBookingSession } from "../../src/standalone/cliniko-intake-booking-session.ts";
import { clinicDateAt } from "../../src/standalone/clinic-clock.ts";
import { lifecycleCall, now, value } from "./cliniko_lifecycle_call.ts";
import type { DemoCredentials } from "./cliniko_lifecycle_call.ts";
import { ClinikoLifecycleFixture, lifecycleDraft, lifecycleScope, requireLive, row, LifecycleFailure } from "./cliniko_lifecycle_fixture.ts";
import type { LiveSelection } from "./cliniko_lifecycle_fixture.ts";

type Call = Awaited<ReturnType<typeof lifecycleCall>>;
type Report = (step: string, facts: Record<string, boolean | number | string>) => void;

async function offerDate(fixture: ClinikoLifecycleFixture, selection: LiveSelection) {
  const path=`/businesses/${selection.businessId}/practitioners/${selection.practitionerId}/appointment_types/${selection.appointmentTypeId}/available_times`;
  // A bounded day-at-a-time search avoids overflowing the adapter's bounded offer pages.
  for(let offset=1; offset<=14; offset++) {
    const date=clinicDateAt(selection.timeZone,new Date(Date.now()+offset*86400000));
    const response=await fixture.request("GET",`${path}?from=${date}&to=${date}&per_page=100`);
    requireLive(Array.isArray(response.available_times),"invalidAvailableTimes");
    if(response.available_times.length>=2) return date;
  }
  throw new Error("noDemoOffers");
}
async function book(call: Call, reception: TextReception, date: string, report: Report) {
  const agent=call.agentFor(reception);
  report("bookingMenuStarted",{syntheticCaller:true});
  value(await agent.submit({kind:"booking.offers.read.v1",turn:call.turn("booking-menu"),from:date,to:date,now:now()}));
  await call.playPending();
  report("bookingSelectionStarted",{choice:1});
  value(await agent.submit({kind:"booking.offers.select.v1",turn:call.turn("booking-select"),choice:1,now:now()}));
  report("bookingConfirmationStarted",{syntheticPlayback:true});return call.finish(reception,"book");
}
async function verifyBooking(fixture: ClinikoLifecycleFixture, action: Awaited<ReturnType<Call["finish"]>>, selection: LiveSelection) {
  requireLive(action.hostRef && action.mutation.request.kind==="book","bookingResultMissing");
  const appointmentId=action.hostRef.match(/^cliniko:appointment:([1-9][0-9]{0,18})$/)?.[1];requireLive(appointmentId,"bookingResultMissing");
  const record=await fixture.inspectAppointment(appointmentId), request=action.mutation.request;
  requireLive(record.cancelled_at===null && record.archived_at===null && Date.parse(String(record.starts_at))===Date.parse(request.offer.startsAt) &&
    Date.parse(String(record.ends_at))-Date.parse(String(record.starts_at))===selection.durationMinutes*60000 &&
    fixture.link(record,"business")===`${fixture.base}/businesses/${selection.businessId}` &&
    fixture.link(record,"practitioner")===`${fixture.base}/practitioners/${selection.practitionerId}` &&
    fixture.link(record,"appointment_type")===`${fixture.base}/appointment_types/${selection.appointmentTypeId}`,"bookingReadbackMismatch");
  const conflicts=await fixture.request("GET",`/individual_appointments/${appointmentId}/conflicts`);
  requireLive(row(conflicts.conflicts).exist===false,"bookingHasConflict");return record;
}

/** Four real-provider workflows. Does not activate the standalone runner or claim real speech/email evidence. */
export async function runClinikoLifecycle(fixture: ClinikoLifecycleFixture, credentials: DemoCredentials, report: Report) {
  let failure: unknown, cleanup=false;
  try {
    const selection=await fixture.prepare(),date=await offerDate(fixture,selection);
    report("prepared",{businessTemporarilyEnabled:fixture.businessTemporarilyEnabled,syntheticMail:true,syntheticPlayback:true});
    let patientId:string, appointmentId:string, originalStartsAt:string;
    const intakeCall=await lifecycleCall(fixture,selection,credentials,undefined,facts=>report("dispatch",facts));
    let intakeOwner:ClinikoIntakeBookingSession|undefined;
    try {
      intakeOwner=value(await ClinikoIntakeBookingSession.create({...intakeCall.config,policy:intakeCall.intakePolicy,
        presentation:{play:async(_text,signal)=>!signal.aborted},
        permission:{allows:async(input)=>isDeepStrictEqual(input.scope,lifecycleScope) && input.callId===intakeCall.callId &&
          input.sessionId===intakeCall.sessionId && isDeepStrictEqual(input.draft,lifecycleDraft) && !input.signal.aborted},
        bookingPermission:{allows:async(bound,id,operation)=>isDeepStrictEqual(bound,lifecycleScope) && operation==="appointments.book" &&
          id===(await intakeOwner?.intake.createdPatient())?.patientId}}));
      const begun=value(await intakeOwner.intake.begin());requireLive(await intakeOwner.intake.acknowledgeRecovery(begun.recoveryRef,true),"intakeRecoveryNotAcknowledged");
      const collected=value(await intakeOwner.intake.collect(lifecycleDraft,{privacyAccepted:true,intakeAccepted:true}));
      const code=intakeCall.code();requireLive(code,"intakeOtpMissing");requireLive((await intakeOwner.intake.submitCode(code)).verified,"intakeOtpRejected");
      const reception=new TextReception(intakeCall.ledger,intakeCall.policies,intakeOwner);
      const agent=intakeCall.agentFor(reception);
      value(await agent.submit({kind:"patients.intake.propose.v1",turn:intakeCall.turn("intake-propose"),draftRef:collected.draftRef,now:now()}));
      const action=await intakeCall.finish(reception,"intake"), created=await intakeOwner.intake.createdPatient();
      requireLive(created && action.hostRef===`cliniko:patient:${created.patientId}`,"intakeReadbackMissing");patientId=created.patientId;
      const patient=await fixture.request("GET",`/patients/${patientId}`);requireLive(fixture.ownsPatient(patient),"intakeReadbackMismatch");
      requireLive(fixture.counts.intake===1 && fixture.counts.book===0,"intakeUnexpectedSend");
      report("intake",{committed:true,exactProviderPatient:true,onePatientSend:true,recoveryAcknowledged:true});
      const booked=await book(intakeCall,reception,date,report),record=await verifyBooking(fixture,booked,selection);
      appointmentId=String(record.id);originalStartsAt=String(record.starts_at);
      report("intakeBooking",{committed:true,exactProviderAppointment:true,conflictInspectionClear:true,separateConfirmation:true});
    } finally {intakeOwner?.dispose();await intakeCall.close();}

    report("providerBudgetCooldown",{seconds:61});await fixture.betweenWorkflows();

    const moveCall=await lifecycleCall(fixture,selection,credentials,patientId,facts=>report("dispatch",facts));
    let moveOwner:ClinikoReschedulingSession|undefined;
    try {
      moveOwner=value(await ClinikoReschedulingSession.create({...moveCall.config,reschedulingApprovalPath:moveCall.reschedulingApprovalPath}));
      await moveCall.verify(moveOwner);
      const reception=new TextReception(moveCall.ledger,moveCall.policies,moveOwner.effects),agent=moveCall.agentFor(reception);
      value(await agent.submit({kind:"rescheduling.menu.read.v1",turn:moveCall.turn("move-target-menu"),stage:"targets",from:now(),to:new Date(Date.now()+15*86400000).toISOString(),now:now()}));
      await moveCall.playPending();
      value(await agent.submit({kind:"rescheduling.menu.select.v1",turn:moveCall.turn("move-target-select"),stage:"targets",choice:1,now:now()}));
      await moveCall.playPending();
      value(await agent.submit({kind:"rescheduling.menu.read.v1",turn:moveCall.turn("move-offers"),stage:"offers",from:date,to:date,now:now()}));
      await moveCall.playPending();
      value(await agent.submit({kind:"rescheduling.menu.select.v1",turn:moveCall.turn("move-select"),stage:"offers",choice:1,now:now()}));
      const action=await moveCall.finish(reception,"reschedule");requireLive(action.mutation.request.kind==="reschedule" && action.hostRef===appointmentId,"rescheduleTargetMismatch");
      const record=await fixture.inspectAppointment(appointmentId);
      requireLive(record.cancelled_at===null && record.starts_at!==originalStartsAt &&
        Date.parse(String(record.starts_at))===Date.parse(action.mutation.request.offer.startsAt) &&
        Date.parse(String(record.ends_at))-Date.parse(String(record.starts_at))===selection.durationMinutes*60000,"rescheduleReadbackMismatch");
      const conflicts=await fixture.request("GET",`/individual_appointments/${appointmentId}/conflicts`);requireLive(row(conflicts.conflicts).exist===false,"rescheduleHasConflict");
      requireLive(fixture.counts.reschedule===1,"rescheduleRepeatedSend");report("rescheduling",{committed:true,sameProviderAppointment:true,timeChanged:true,oneMoveSend:true,conflictInspectionClear:true});
    } finally {moveOwner?.dispose();await moveCall.close();}

    report("providerBudgetCooldown",{seconds:61});await fixture.betweenWorkflows();

    const cancelCall=await lifecycleCall(fixture,selection,credentials,patientId,facts=>report("dispatch",facts));
    let cancelOwner:ClinikoCancellationSession|undefined;
    try {
      cancelOwner=value(await ClinikoCancellationSession.create({...cancelCall.config,cancellationApprovalPath:cancelCall.cancellationApprovalPath}));
      const proof=await cancelCall.verify(cancelOwner),reception=new TextReception(cancelCall.ledger,cancelCall.policies,cancelOwner.effects,undefined,cancelOwner.appointments),agent=cancelCall.agentFor(reception);
      value(await agent.submit({kind:"appointments.read.v1",turn:cancelCall.turn("cancel-menu"),verificationRef:proof,from:now(),to:new Date(Date.now()+15*86400000).toISOString(),now:now()}));
      await cancelCall.playPending();
      value(await agent.submit({kind:"appointments.change.propose.v1",turn:cancelCall.turn("cancel-propose"),selection:{kind:"cancel",verificationRef:proof,targetRef:"selected"},now:now()}));
      const action=await cancelCall.finish(reception,"cancel");requireLive(action.hostRef===appointmentId,"cancellationTargetMismatch");
      const record=await fixture.inspectAppointment(appointmentId);requireLive(typeof record.cancelled_at==="string" && record.cancellation_reason===50,"cancellationReadbackMismatch");
      requireLive(fixture.counts.cancel===1,"cancelRepeatedSend");report("cancellation",{committed:true,exactProviderCancellation:true,oneCancelSend:true});
    } finally {cancelOwner?.dispose();await cancelCall.close();}

    report("providerBudgetCooldown",{seconds:61});await fixture.betweenWorkflows();

    const existingCall=await lifecycleCall(fixture,selection,credentials,patientId,facts=>report("dispatch",facts));
    let existingOwner:ClinikoBookingSession|undefined;
    try {
      existingOwner=value(await ClinikoBookingSession.create(existingCall.config));await existingCall.verify(existingOwner);
      const reception=new TextReception(existingCall.ledger,existingCall.policies,existingOwner.effects);
      await verifyBooking(fixture,await book(existingCall,reception,date,report),selection);
      requireLive(Number(fixture.counts.book)===2 && fixture.counts.recall===4 && fixture.counts.intake===1,"unexpectedWorkflowSendCounts");
      report("existingPatientBooking",{committed:true,exactProviderAppointment:true,conflictInspectionClear:true,oneAdditionalBookingSend:true});
    } finally {existingOwner?.dispose();await existingCall.close();}
  } catch(error) { failure=error;report("workflowFailure",{kind:error instanceof LifecycleFailure ? error.kind : "unavailable",...fixture.reads,...fixture.counts}); }
  finally {
    try {if(fixture.ownsRun) {await fixture.betweenWorkflows();await fixture.cleanup();cleanup=true;report("cleanup",{archivedFixturesVerified:true,businessRestored:true});}}
    catch(error) {failure=error;report("cleanup",{archivedFixturesVerified:false,businessRestored:fixture.businessRestored,businessRestorationNeedsInspection:!fixture.businessRestored});}
  }
  if(failure) throw failure;return {ok:true,cleanup,...fixture.counts};
}
