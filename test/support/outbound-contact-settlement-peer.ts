import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { outboundContactSettlementFixture } from "./outbound-contact-settlement.ts";

type Fixture=Awaited<ReturnType<typeof outboundContactSettlementFixture>>;
export async function outboundSettlementPeer(f:Fixture,cwd:string,onHeld:()=>void,hold:"dncAck"|"outcomeAck"|"release"){
  const child=fork(new URL('./outbound-contact-settlement-worker.mjs',import.meta.url),[],{cwd,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,NODE_OPTIONS:'--max-old-space-size=256'}});
  const output:string[]=[];child.stdout?.on('data',v=>output.push(String(v)));child.stderr?.on('data',v=>output.push(String(v)));
  const terminal=new Promise<NodeJS.Signals|null>(resolve=>child.once('exit',(_code,signal)=>resolve(signal)));
  let failed!:(e:Error)=>void;const errors=new Promise<never>((_,reject)=>{failed=reject;});errors.catch(()=>{});child.once('error',()=>failed(Error('Synthetic settlement process unavailable')));
  child.on('message',async raw=>{
    const m=raw as {kind:string;id:number;data:any};let data:unknown;const signal=new AbortController().signal;
    if(m.kind==='workerError'||m.kind==='result'){failed(Error('Synthetic settlement ended before held boundary'));return;}
    try{
      if(m.kind==='directory')data=await f.directory[m.data.method as 'findByRef'|'findByEmail'](m.data.ref);
      else if(m.kind==='definition')data=await f.definition.currentFor(m.data,signal);
      else if(m.kind==='revision')data=await f.config.stop.dnc.source.contactRevision.read(m.data);
      else if(m.kind==='report')data=await f.ports.provider.inspectContact(m.data,signal);
      else if(m.kind==='terminal')data=await f.ports.provider.inspectTerminal(m.data,signal);
      else if(m.kind==='beforeRelease'){if(hold==='release'){onHeld();return;}data=true;}
      else if(m.kind==='fetch'){
        const request=m.data,response=await f.nativeSettlement(request.input,{method:request.method,headers:request.headers,redirect:'error',signal,...(request.body===undefined?{}:{body:request.body})});
        const type=request.method==='POST'?JSON.parse(request.body).recall_type_id:undefined;
        if(type===(hold==='dncAck'?'91':hold==='outcomeAck'?'63':'unused')){onHeld();return;}
        data={body:await response.text(),status:response.status};
      }else if(m.kind==='grant'){
        const q=m.data.query;
        switch(m.data.family){
          case 'request':data=f.ports.stop.request.current(q,signal)&&await f.ports.stop.request.allows(q,signal);break;
          case 'attempt':data=f.ports.stop.attempt.current(q,signal)&&await f.ports.stop.attempt.allows(q,signal);break;
          case 'contact':data=f.ports.stop.contact.current(q,signal)&&await f.ports.stop.contact.allows(q,signal);break;
          case 'dnc':data=f.ports.stop.record.current(q,signal)&&await f.ports.stop.record.allows(q,signal);break;
          case 'dncProducer':data=f.ports.stop.record.current(q,signal)&&await f.ports.stop.record.producerAdmitted(q,signal);break;
          case 'stop':data=f.ports.stop.authority.current(q,signal)&&await f.ports.stop.authority.allows(q,signal);break;
          case 'outcome':data=f.ports.outcomes.current(q,signal)&&await f.ports.outcomes.allows(q,signal);break;
          case 'outcomeProducer':data=f.ports.outcomes.current(q,signal)&&await f.ports.outcomes.producerAdmitted(q,signal);break;
          case 'history':data=f.ports.history.current(q,signal)&&await f.ports.history.allowsHistoryRead(q,signal);break;
          case 'historyRecord':data=f.ports.history.current(q,signal)&&await f.ports.history.allowsRecordRead(q,signal);break;
          case 'settlement':data=f.ports.authority.current(q,signal)&&await f.ports.authority.allows(q,signal);break;
          default:throw Error('Synthetic grant unavailable');
        }
      }else throw Error('Synthetic operation unavailable');
    }catch{data=m.kind==='fetch'?{failed:true}:false;}
    if(child.connected)child.send({kind:'reply',id:m.id,data});
  });
  const strip=(v:Record<string,unknown>)=>Object.fromEntries(Object.entries(v).filter(([key])=>!['clock','rateBudget','contactRevision'].includes(key)));
  child.send({kind:'start',data:{requests:strip(f.config.stop.requests),attempts:strip(f.config.stop.attempts),contact:strip(f.config.stop.dnc.source),outcomes:strip(f.config.outcomes),
    accountPath:f.captureConfig.path,policyPath:f.policyPath,automationPrincipalRef:f.config.stop.dnc.automationPrincipalRef,guardRef:f.guardRef,now:f.state.now,provider:f.providerBinding,binding:f.stopBinding}});
  return {output,errors,async kill(){if(child.exitCode===null&&child.signalCode===null){assert.ok(child.kill('SIGKILL'));assert.equal(await terminal,'SIGKILL');}}};
}
