import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import { TwilioAbbyOutboundRuntime } from "../../src/voice/twilio-outbound-runtime.ts";
import { TwilioOutboundIngress } from "../../src/voice/twilio-outbound-ingress.ts";
import type { TwilioOutboundIngressConfig, TwilioOutboundIngressQuery } from "../../src/voice/twilio-outbound-ingress.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";
import { TwilioMediaStream } from "../../src/voice/twilio-media-stream.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { outboundLaunchValue } from "./outbound-launch.ts";
import { outboundRequestValue } from "./outbound-recipient-request.ts";

export async function twilioOutboundIngressFixture(options: {
  claimWait?: () => Promise<void>; allow?: (query: TwilioOutboundIngressQuery) => Promise<boolean>; deadlineMs?: number;
  createWait?: () => Promise<void>; profileRef?: string;
  callSid?: string; streamSid?: string;
  identities?: Readonly<{ accountSid: string; authToken: string; contextKey: Uint8Array; callSid: string; streamSid: string;
    patientId: string; recipientNumber: string; nativeRecallId: string }>;
  sessionEffects?: TwilioOutboundIngressConfig["sessionEffects"];
  conversation?: (runtime: TwilioAbbyOutboundRuntime) => TwilioOutboundIngressConfig["createCall"];
} = {}) {
  const state = { allowed: true, current: true, created: 0, disconnected: 0, progress: [] as string[],
    claims: [] as string[], burned: new Set<string>(), frames: [] as string[], queries: [] as TwilioOutboundIngressQuery[] };
  const config = { ref: "twilio-abby", profileRef: options.profileRef ?? "generic-outbound", accountSid: options.identities?.accountSid ?? `AC${"a".repeat(32)}`, authToken: options.identities?.authToken ?? "synthetic-twilio-token",
    from: "+61255550100", publicAnswerUrl: "https://clinic.example.invalid/outbound/answer", publicStatusUrl: "https://clinic.example.invalid/outbound/status",
    publicStreamUrl: "wss://clinic.example.invalid/outbound/stream", contextKey: options.identities?.contextKey ?? new Uint8Array(32).fill(7), now: () => "2026-11-01T10:00:00.000Z" };
  const callSid = options.identities?.callSid ?? options.callSid ?? `CA${"b".repeat(32)}`, streamSid = options.identities?.streamSid ?? options.streamSid ?? `MZ${"c".repeat(32)}`; let form!: URLSearchParams;
  const runtime = new TwilioAbbyOutboundRuntime(config, async (_url, init) => {
    form = new URLSearchParams(String(init?.body));
    return Response.json({ account_sid: config.accountSid, sid: callSid, to: form.get("To"), from: config.from, direction: "outbound-api", status: "queued",
      parent_call_sid: null, uri: `/2010-04-01/Accounts/${config.accountSid}/Calls/${callSid}.json` }, { status: 201 });
  });
  const request = outboundRequestValue(), seed = outboundLaunchValue(options.identities ? { ...request,
    patientId: options.identities.patientId, recipient: { kind: "voice", number: options.identities.recipientNumber } } : request);
  const provider = runtime.binding(), call = { effectRef: seed.attempt.effectRef,
    capacityAllocationRef: randomUUID(), number: options.identities?.recipientNumber ?? "+61455550123", profileRef: provider.profileRef };
  const original = { recallRef: options.identities ? `cliniko:recall:${BigInt(options.identities.nativeRecallId) + 1n}` : "cliniko:recall:40", attempt: {
    ...seed.attempt, ...(options.identities ? { requestRecallRef: `cliniko:recall:${options.identities.nativeRecallId}` } : {}), capacityAllocationRef: call.capacityAllocationRef,
    provider: { ref: provider.ref, bindingDigest: provider.bindingDigest }, dncReferences: { actionRef: randomUUID(), approvalRef: randomUUID() },
    contactReferences: { guardRef: randomUUID(), allocationRef: randomUUID(), outcomeActionRef: randomUUID() } } };
  assert.equal((await runtime.launchOnce(call, new AbortController().signal, async () => true, () => {}, original)).kind, "accepted");
  const makeRouter = (selected = new TwilioAbbyOutboundRuntime(config)) => new TwilioOutboundIngress({ runtime: selected,
    authority: { allows: async query => { state.queries.push(query); return state.allowed && (!options.allow || await options.allow(query)); }, current: () => state.current },
    sessionEffects: (scope, binding) => {
      const selected = options.sessionEffects?.(scope, binding);
      return { matches: (s, b) => JSON.stringify(s) === JSON.stringify(scope) && b === binding && (!selected || selected.matches(s, b)),
        async claimOnce(ref) {
          await options.claimWait?.(); state.claims.push(ref);
          if (selected) {
            const result = await selected.claimOnce(ref);
            if (result.ok && result.value.claimed) state.burned.add(ref);
            return result;
          }
          const claimed = !state.burned.has(ref); state.burned.add(ref); return { ok: true, value: { claimed } };
        } };
    },
    async createCall(stream, send, close, signal) {
      assert.equal(stream.call.kind, "authenticatedOutboundCall"); assert.equal("event" in stream, false);
      assert.equal(state.burned.has(stream.call.context.sessionActionRef), true);
      assert.equal(state.burned.has(stream.call.context.reportActionRef), false);
      assert.notEqual(stream.call.context.sessionActionRef, stream.call.context.reportActionRef);
      state.created++; await options.createWait?.();
      if (options.conversation) {
        const owned = await options.conversation(selected)(stream, send, close, signal);
        return { receive: owned.receive, async disconnect() { state.disconnected++; await owned.disconnect(); } };
      }
      const media = new TwilioMediaStream({ accountSid: stream.call.accountSid, callSid: stream.call.callSid,
        sessionId: randomUUID(), startedAt: stream.streamStartedAt, send });
      return { async receive(raw) { const result = media.receive(raw); if (result.ok) {
        state.frames.push(result.value.kind); if (result.value.kind === "started") send(JSON.stringify({ event: "ready" })); }
        return { ok: result.ok }; }, async disconnect() { state.disconnected++; media.close(); } };
    }, observeProgress: async event => { state.progress.push(event.status); }, ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}) });
  async function listen(router = makeRouter()) {
    const ingress = new TwilioSignedIngress({ accountSid: config.accountSid, authToken: config.authToken,
      publicWebhookUrl: "https://clinic.example.invalid/inbound", publicStreamUrl: "wss://clinic.example.invalid/inbound/stream",
      fallbackNumbers: { [config.from]: "+61255550199" }, bindingKey: new Uint8Array(32).fill(9), now: () => new Date(config.now()) });
    const server = createTwilioIngressServer({ ingress, outbound: router, createCall: async () => { throw Error("Outbound must never enter inbound construction"); } });
    const wire = await listenTwilioOutboundTest(server, { config, form, number: call.number, callSid, streamSid });
    return { ...wire, router };

  }
  return { state, config, runtime, original, call, callSid, streamSid, form, makeRouter, listen };
}

export type TwilioOutboundTestSetup = Readonly<{
  config: Readonly<{ accountSid: string; authToken: string; from: string; publicStreamUrl: string }>;
  form: URLSearchParams; number: string; callSid: string; streamSid: string;
}>;

export function twilioOutboundTestClient(base: string, setup: TwilioOutboundTestSetup) {
  const sockets = new Set<WebSocket>();
  const post = (kind: "answer" | "status" = "answer", patch: Record<string, string> = {}, valid = true) => {
    const publicUrl = setup.form.get(kind === "answer" ? "Url" : "StatusCallback")!, url = new URL(publicUrl);
    const fields = { AccountSid: setup.config.accountSid, CallSid: setup.callSid, From: setup.config.from, To: setup.number, Direction: "outbound-api", CallStatus: "in-progress", ...patch };
    return fetch(base + url.pathname + url.search, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
    "x-twilio-signature": valid ? getExpectedTwilioSignature(setup.config.authToken, publicUrl, fields) : "foreign" }, body: new URLSearchParams(fields).toString() });
  };
  async function open(xml: string, patch: Record<string, unknown> = {}) {
    const socket = new WebSocket(base.replace("http:", "ws:") + "/outbound/stream", { headers: {
    "x-twilio-signature": getExpectedTwilioSignature(setup.config.authToken, setup.config.publicStreamUrl, {}) } }); sockets.add(socket);
    await once(socket, "open");
    const parameters: Record<string, string> = {};
    for (const m of xml.matchAll(/<Parameter name="([^"]+)" value="([^"]+)"\s*\/>/g)) parameters[m[1]!] = m[2]!;
    const outcome = new Promise<"ready" | "closed">((resolve, reject) => { socket.once("message", () => resolve("ready")); socket.once("close", () => resolve("closed")); socket.once("error", reject); });
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: setup.streamSid, start: { streamSid: setup.streamSid, accountSid: setup.config.accountSid, callSid: setup.callSid,
    tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }, customParameters: parameters, ...patch } }));
    return { socket, outcome };
  }
  return { base, post, open, terminate() { for (const socket of sockets) socket.terminate(); } };
}
export async function listenTwilioOutboundTest(server: import("node:http").Server, setup: TwilioOutboundTestSetup) {
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = twilioOutboundTestClient(`http://127.0.0.1:${address.port}`, setup); let closed = false;
  return { ...client, server, async close() { if (closed) return; closed = true; client.terminate(); const done = once(server, "close"); server.close(); await done; } };
}
