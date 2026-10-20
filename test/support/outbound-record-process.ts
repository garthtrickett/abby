/** Compiled one-operation synthetic recorder. Private IPC only; no launcher,
 * listener or retry file. Provider fixtures and current grants outlive us. */
import { ClinikoOutboundLaunchHistory } from "../../src/cliniko/outbound-launch-history.ts";
import type { OutboundLaunchHistoryQuery } from "../../src/cliniko/outbound-launch-history.ts";
import { ClinikoOutboundLaunchRecords, outboundLaunchRecordOwnerBinding } from "../../src/cliniko/outbound-launch-records.ts";
import type { OutboundLaunchRecordConfig, OutboundLaunchRecordQuery } from "../../src/cliniko/outbound-launch-records.ts";
import type { OutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import { ClinikoOutboundPendingDiscovery } from "../../src/cliniko/outbound-pending-discovery.ts";
import type { OutboundPendingAccountQuery } from "../../src/cliniko/outbound-pending-discovery.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresOutboundEffectBarrier } from "../../src/storage/postgres-outbound-effect-barrier.ts";
import { ClinikoOutboundRecipientRecords, outboundRecordOwnerBinding } from "../../src/cliniko/outbound-recipient-records.ts";
import type { OutboundRecordConfig, OutboundRecordQuery } from "../../src/cliniko/outbound-recipient-records.ts";
import type { OutboundRecipientRequest } from "../../src/cliniko/outbound-recipient-request.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
type RecipientRecorderSetup = Readonly<{ kind: "start"; now: string; config: Omit<OutboundRecordConfig, "clock" | "rateBudget">;
}> & (Readonly<{ mode: "retain"; request: OutboundRecipientRequest; recallAt: string }> |
  Readonly<{ mode: "read"; request: OutboundRecipientRequest; recallRef: string }> | Readonly<{ mode: "pending" }>);
export type OutboundLaunchRecorderSetup = Readonly<{ kind:"start"; now:string; config:Omit<OutboundLaunchRecordConfig,"clock"|"rateBudget"> }> &
  (Readonly<{mode:"retainPossible";attempt:OutboundLaunchAttempt;recallAt:string}> |
   Readonly<{mode:"readPossible";attempt:OutboundLaunchAttempt;recallRef:string}> |
   Readonly<{mode:"history";request:OutboundRecipientRequest;requestRecallRef:string}>);
export type OutboundRecorderSetup = RecipientRecorderSetup | OutboundLaunchRecorderSetup;
let id = 0, started = false;
const replies = new Map<number, (data: unknown) => void>();
const rpc = (kind: string, data: unknown): Promise<unknown> => new Promise(resolve => { const requestId = ++id; replies.set(requestId, resolve); process.send?.({ kind, id: requestId, data }); });
const port: typeof fetch = async (input, init) => {
  const r = await rpc("fetch", { input: String(input), method: init?.method, body: init?.body, headers: Object.fromEntries(new Headers(init?.headers)) }) as { failed?: boolean; status: number; body: string };
  if (r.failed) throw new Error("Synthetic provider unavailable");
  return new Response([204, 205, 304].includes(r.status) ? null : r.body, { status: r.status });
};
process.on("message", async (raw: unknown) => {
  const reply = raw as { kind: string; id: number; data: unknown };
  if (reply?.kind === "reply") { replies.get(reply.id)?.(reply.data); replies.delete(reply.id); return; }
  const setup = raw as OutboundRecorderSetup; if (setup?.kind !== "start" || started) return; started = true;
  let db: ReturnType<typeof connectPostgres> | undefined;
  try {
    if(setup.mode === "retainPossible" || setup.mode === "readPossible" || setup.mode === "history") {
      const config:OutboundLaunchRecordConfig={...setup.config,clock:()=>setup.now,
        rateBudget:{claim:()=>rpc("claim",null) as ReturnType<ClinikoRequestBudget["claim"]>,
          observe429:reset=>rpc("observe429",reset) as ReturnType<ClinikoRequestBudget["observe429"]>}};
      const read={allows:async(query:OutboundLaunchRecordQuery)=>await rpc("grant",{purpose:"record",query})===true,current:()=>process.connected};
      const signal=new AbortController().signal;process.send?.({kind:"ready"});
      if(setup.mode === "history") {
        const history=ClinikoOutboundLaunchHistory.create(config,{allowsHistoryRead:async(query:OutboundLaunchHistoryQuery)=>await rpc("historyGrant",query)===true,
          allowsRecordRead:read.allows,current:()=>process.connected},port);
        if(!history.ok)throw new Error("Synthetic history unavailable");
        process.send?.({kind:"result",data:await history.value.readForRequest({recallRef:setup.requestRecallRef,request:setup.request},signal)});return;
      }
      if(setup.mode === "readPossible") {
        const reader=ClinikoOutboundLaunchRecords.createReadOnly(config,read,port);if(!reader.ok)throw new Error("Synthetic possible reader unavailable");
        process.send?.({kind:"result",data:await reader.value.readPossibleAttempt({recallRef:setup.recallRef,actionRef:setup.attempt.actionRef,patientId:setup.attempt.patientId},signal)});return;
      }
      db=connectPostgres(process.env.DATABASE_URL!);const owner=outboundLaunchRecordOwnerBinding(config);if(!owner)throw new Error("Synthetic possible owner unavailable");
      const records=ClinikoOutboundLaunchRecords.create(config,{...read,producerAdmitted:async query=>await rpc("grant",{purpose:"producer",query})===true},
        new PostgresOutboundEffectBarrier(db,config.scope,owner),port);
      if(!records.ok)throw new Error("Synthetic possible recorder unavailable");
      process.send?.({kind:"result",data:await records.value.retainPossibleAttemptOnce(setup.attempt,setup.recallAt,signal)});return;
    }
    const config: OutboundRecordConfig = { ...setup.config, clock: () => setup.now,
      rateBudget: { claim: () => rpc("claim", null) as ReturnType<ClinikoRequestBudget["claim"]>,
        observe429: reset => rpc("observe429", reset) as ReturnType<ClinikoRequestBudget["observe429"]> } };
    const read = { allows: async (query: OutboundRecordQuery) => await rpc("grant", { purpose: "record", query }) === true,
      current: () => process.connected };
    const signal = new AbortController().signal;
    process.send?.({ kind: "ready" });
    if (setup.mode === "pending") {
      const reader = ClinikoOutboundPendingDiscovery.create(config, {
        allowsPendingRead: async (query: OutboundPendingAccountQuery) => await rpc("pendingGrant", query) === true,
        allowsRecordRead: read.allows, current: () => process.connected,
      }, port);
      if (!reader.ok) throw new Error("Synthetic pending reader unavailable");
      process.send?.({ kind: "result", data: await reader.value.scanPending(signal) }); return;
    }
    if (setup.mode === "read") {
      const reader = ClinikoOutboundRecipientRecords.createReadOnly(config, read, port);
      if (!reader.ok) throw new Error("Synthetic reader unavailable");
      const result = await reader.value.readRequest({ recallRef: setup.recallRef, actionRef: setup.request.actionRef, patientId: setup.request.patientId }, signal);
      process.send?.({ kind: "result", data: result }); return;
    }
    db = connectPostgres(process.env.DATABASE_URL!); const owner = outboundRecordOwnerBinding(config);
    if (!owner) throw new Error("Synthetic owner unavailable");
    const records = ClinikoOutboundRecipientRecords.create(config, { ...read,
      producerAdmitted: async query => await rpc("grant", { purpose: "producer", query }) === true }, new PostgresOutboundEffectBarrier(db, config.scope, owner), port);
    if (!records.ok) throw new Error("Synthetic recorder unavailable");
    const result = await records.value.retainRequestOnce(setup.request, setup.recallAt, signal);
    process.send?.({ kind: "result", data: result });
  } catch { process.send?.({ kind: "workerError" }); }
  finally { await db?.destroy(); }
});
