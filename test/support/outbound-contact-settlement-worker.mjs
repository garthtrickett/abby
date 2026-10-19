/** Synthetic emitted settlement owner; private context crosses IPC only. */
const emitted = new URL('../../dist/runtime/src/', import.meta.url);
const load = path => import(new URL(path, emitted));
const { connectPostgres } = await load('storage/connect.js');
const { PostgresClinikoRequestBudget } = await load('storage/postgres-cliniko-request-budget.js');
const { PostgresOutboundEffectBarrier } = await load('storage/postgres-outbound-effect-barrier.js');
const { PostgresOutboundCapacity } = await load('storage/postgres-outbound-capacity.js');
const { outboundContactGuardOwnerBinding } = await load('core/outbound-capacity.js');
const { ClinikoOutboundContactSettlement } = await load('standalone/cliniko-outbound-contact-settlement.js');
const { OwnerFileOutboundContactAccount } = await load('standalone/owner-file-outbound-contact-account.js');
const { OwnerFileOutboundDncPolicy } = await load('standalone/owner-file-outbound-dnc-policy.js');
const { contactSourceSelection } = await load('cliniko/outbound-contact-source.js');
const { outboundDncRecordBinding } = await load('cliniko/outbound-dnc-records.js');
const { outboundContactOutcomeRecordBinding } = await load('cliniko/outbound-contact-outcome-records.js');
const { clinikoCredentialFingerprint } = await load('cliniko/read-budget.js');
let next = 0, started = false;
const pending = new Map();
const rpc = (kind, data) => new Promise(resolve => { const id=++next; pending.set(id,resolve);process.send?.({kind,id,data}); });
process.on('message',async message=>{
  if(message?.kind==='reply'){pending.get(message.id)?.(message.data);pending.delete(message.id);return;}
  if(message?.kind!=='start'||started)return;started=true;let db;
  try{
    const s=message.data,clock=()=>s.now;db=connectPostgres(process.env.DATABASE_URL);
    const budget=new PostgresClinikoRequestBudget(db,{apiKey:s.requests.apiKey,maxPerMinute:180});
    const requests={...s.requests,clock,rateBudget:budget},attempts={...s.attempts,clock,rateBudget:budget},outcomes={...s.outcomes,clock,rateBudget:budget};
    const directory={findByRef:ref=>rpc('directory',{method:'findByRef',ref}),findByEmail:ref=>rpc('directory',{method:'findByEmail',ref})};
    const definition={currentFor:selection=>rpc('definition',selection)};
    const source={...s.contact,clock,rateBudget:budget,contactRevision:{matches:(tenant,fp)=>tenant===requests.scope.tenantId&&fp===clinikoCredentialFingerprint(requests.apiKey),read:fp=>rpc('revision',fp)}};
    const account=await OwnerFileOutboundContactAccount.capture({path:s.accountPath,scope:requests.scope,credentialFingerprint:clinikoCredentialFingerprint(requests.apiKey),directory,clock,definitions:[{selection:contactSourceSelection(source),definition}]},new AbortController().signal);
    const policy=await OwnerFileOutboundDncPolicy.capture({path:s.policyPath,scope:requests.scope,directory,clock},new AbortController().signal);
    if(!account.ok||!policy.ok)throw Error('Synthetic source unavailable');
    const dnc={source,automationPrincipalRef:s.automationPrincipalRef};
    const grant=family=>({allows:query=>rpc('grant',{family,query}),current:()=>process.connected});
    const native=async(input,init)=>{const r=await rpc('fetch',{input:String(input),method:init?.method,headers:Object.fromEntries(new Headers(init?.headers)),body:init?.body});
      if(r.failed)throw Error('Synthetic native unavailable');return new Response(r.body,{status:r.status});};
    const capacity=new PostgresOutboundCapacity(db,requests.scope,outboundContactGuardOwnerBinding(s.guardRef));
    const owner=ClinikoOutboundContactSettlement.create({stop:{requests,attempts,dnc,policy:policy.value,maximumNativeRequests:60,deadlineMs:15000},outcomes,
      account:account.value,guardRef:s.guardRef,capacityScope:requests.scope,maximumNativeRequests:100,deadlineMs:15000},{
      stop:{request:grant('request'),attempt:grant('attempt'),contact:grant('contact'),definition,record:{...grant('dnc'),producerAdmitted:query=>rpc('grant',{family:'dncProducer',query})},
        effects:new PostgresOutboundEffectBarrier(db,requests.scope,outboundDncRecordBinding(dnc)),authority:grant('stop')},
      outcomes:{...grant('outcome'),producerAdmitted:query=>rpc('grant',{family:'outcomeProducer',query})},
      history:{allowsHistoryRead:query=>rpc('grant',{family:'history',query}),allowsRecordRead:query=>rpc('grant',{family:'historyRecord',query}),current:()=>process.connected},
      outcomeEffects:new PostgresOutboundEffectBarrier(db,requests.scope,outboundContactOutcomeRecordBinding(outcomes)),
      provider:{binding:()=>s.provider,inspectContact:identity=>rpc('report',identity),inspectTerminal:identity=>rpc('terminal',identity)},authority:grant('settlement'),native,
      capacity:{matches:capacity.matches.bind(capacity),releaseOnce:async(ref,current)=>{await rpc('beforeRelease',{ref});return capacity.releaseOnce(ref,current);}},
    });
    if(!owner.ok)throw Error('Synthetic settlement unavailable');
    const result=await owner.value.settleOnce(s.binding,new AbortController().signal);process.send?.({kind:'result',data:result});
  }catch{process.send?.({kind:'workerError'});}finally{await db?.destroy();process.disconnect?.();}
});
