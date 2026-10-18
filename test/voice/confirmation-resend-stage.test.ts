import assert from 'node:assert/strict';
import test from 'node:test';
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
test('actual synthetic private resend reports active fixed stages without private diagnostic values',{timeout:120000},async()=>{
 await withClinicalRunner('confirmationResend',async call=>{
  await call.say('Please resend my appointment confirmation email.');await call.mark();await call.verify();
  await voiceUntil(()=>call.spoken.some(s=>s.includes('Choose the appointment')),'private resend menu');
  await call.keypad('1');for(let i=0;i<15;i++)call.media(true);await call.mark();await call.digit('2');
  await voiceUntil(()=>call.spoken.some(s=>s.includes('Please check the email recipient')),'private recipient readback');
  await call.keypad('*');await voiceUntil(()=>call.messages.some(m=>m.kind==='privateChoiceResult'&&m.accepted===false),'stopped private choice');
  const before=call.messages.filter(m=>m.kind==='resendSourceDiagnostic').length;
  call.child.send({kind:'resendDiagnostics'});
  await voiceUntil(()=>call.messages.filter(m=>m.kind==='resendSourceDiagnostic').length>before,'current resend stage snapshot');
  const diagnostic=call.messages.filter(m=>m.kind==='resendSourceDiagnostic').at(-1)?.diagnostic;
  assert.ok(diagnostic!==null&&typeof diagnostic==='object'&&!Array.isArray(diagnostic),'diagnostic object required');
  const allowed=new Set(['verifiedSubject','exactEvidence','recipientSession','selectedEvidence','ledgerRead','directPrivatePlayback','ownedPrivatePlayback','clinicPolicy','hostMembership','nativeProvider','menu','choice','voiceSpeechStarted','voiceFinishTurn','transcriptionAccept','transcriptionFlush']);
  for(const [name,value] of Object.entries(diagnostic)){
   assert.ok(allowed.has(name),'only fixed stage names may be disclosed');
   assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value),'numeric stage object required');
   assert.ok(Object.keys(value).sort().join(',')==='count,maximumMs,pending,pendingMaximumMs,totalMs','only approved numeric counters may be disclosed');
   assert.ok(Object.values(value).every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0),'finite nonnegative counters required');
   assert.ok(Number.isInteger(value.count)&&Number.isInteger(value.pending)&&value.pending<=value.count,'valid active stage counts required');
  }
  for(const name of ['verifiedSubject','exactEvidence','recipientSession','selectedEvidence','ledgerRead','ownedPrivatePlayback','voiceSpeechStarted','voiceFinishTurn','transcriptionAccept','transcriptionFlush']) {
   const row=Object.entries(diagnostic).find(([key])=>key===name)?.[1];
   assert.ok(row!==null&&typeof row==='object'&&'count' in row&&typeof row.count==='number'&&row.count>0,`actual ${name} stage must be observed`);
  }
  assert.equal(call.mutations.length,0);const mail=call.messages.find(m=>m.kind==='verificationEmail');assert.ok(mail?.code);
  await call.scan(['registered-session@example.test','private-session-chart',mail.code]);
 });
});
