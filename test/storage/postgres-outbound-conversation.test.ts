import assert from "node:assert/strict";
import test, { after } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { ok } from "../../src/core/model.ts";
import type { LocationScope, AdmissionReceipt } from "../../src/core/model.ts";
import type { MemoryLedger } from "../../src/core/ledger.ts";
import type { OutboundConversationApproval } from "../../src/voice/outbound-voice-entry.ts";
import { outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { postgresTwilioOutboundFixture, postgresTwilioOutboundPrivacy as privacy } from "../support/postgres-twilio-outbound.ts";
import { listenTwilioOutboundTest, twilioOutboundTestClient } from "../support/twilio-outbound-ingress.ts";
import { value } from "../support/outbound-records.ts";
import { approvedSyntheticPolicy, syntheticSpeech, withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const callerCanary = "Synthetic outgoing caller turn private canary 823714";
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { outboundConversationProfileRef } = await import(new URL("voice/outbound-voice-entry.js", emitted).href) as typeof import("../../src/voice/outbound-voice-entry.ts");
const { twilioAbbyOutboundConversation } = await import(new URL("standalone/twilio-outbound-conversation.js", emitted).href) as typeof import("../../src/standalone/twilio-outbound-conversation.ts");
const { VoiceSession } = await import(new URL("voice/voice-session.js", emitted).href) as typeof import("../../src/voice/voice-session.ts");
const { TextReception } = await import(new URL("reference/text-reception.js", emitted).href) as typeof import("../../src/reference/text-reception.ts");
const { DisabledStandaloneHost } = await import(new URL("standalone/disabled-host.js", emitted).href) as typeof import("../../src/standalone/disabled-host.ts");
const { TwilioAbbyOutboundRuntime } = await import(new URL("voice/twilio-outbound-runtime.js", emitted).href) as typeof import("../../src/voice/twilio-outbound-runtime.ts");
const { TwilioOutboundIngress } = await import(new URL("voice/twilio-outbound-ingress.js", emitted).href) as typeof import("../../src/voice/twilio-outbound-ingress.ts");
const { TwilioSignedIngress } = await import(new URL("voice/twilio-signed-ingress.js", emitted).href) as typeof import("../../src/voice/twilio-signed-ingress.ts");
const { createTwilioIngressServer } = await import(new URL("voice/twilio-ingress-server.js", emitted).href) as typeof import("../../src/voice/twilio-ingress-server.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
function approvalFor(scope: LocationScope): OutboundConversationApproval {
  return { purpose: "outboundContact", runtimeConfigurationHash: "a".repeat(64), mediaOptions: { silenceMs: 100 }, policy: approvedSyntheticPolicy({ ...referenceDefaultPolicy(scope), automationEnabled: true,
    greeting: { scope, version: "outbound-v1", ownerRef: "clinic-owner", approved: true, approvedText: "Hello, this is Abby calling on behalf of the clinic.",
      effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveUntil: "2026-12-01T00:00:00.000Z" } }) };
}
async function fixture() {
  let approval!: OutboundConversationApproval;
  const f = await postgresTwilioOutboundFixture(db, "accepted", { profileRef: scope => {
    approval = approvalFor(scope); return outboundConversationProfileRef(approval)!;
  } });
  return { ...f, conversationApproval: approval, get form() { return f.form; }, get requests() { return f.requests; }, get posts() { return f.posts; }, get claims() { return f.claims; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const setup = (f: Fixture) => ({ config: f.twilioConfig, form: f.form, number: f.request.recipient.number, callSid: f.callSid, streamSid: `MZ${"c".repeat(32)}` });
function state() { return { disposed: [] as Promise<void>[], current: true, created: 0, turns: [] as string[], spoken: [] as string[], owners: [] as { ledger: MemoryLedger; receipt: AdmissionReceipt }[] }; }
async function server(f: Fixture, shared = state(), policyWait?: () => Promise<void>) {
  const config = { ...f.twilioConfig, now: () => f.state.now }, runtime = new TwilioAbbyOutboundRuntime(config), provider = runtime.binding();
  const allowed = (q: import("../../src/voice/twilio-outbound-ingress.ts").TwilioOutboundIngressQuery) =>
    isDeepStrictEqual(q.call.context.original.attempt.scope, f.scope) && isDeepStrictEqual(q.provider, provider) && q.call.context.attemptDigest === outboundLaunchAttemptDigest(f.retained().attempt);
  const conversation = twilioAbbyOutboundConversation({ runtime, runtimeConfigurationHash: "a".repeat(64), mediaOptions: { silenceMs: 100 }, now: () => f.state.now,
    source: { read: async () => { await policyWait?.(); return ok(f.conversationApproval); }, current: () => shared.current }, readiness: async () => ok(true),
    ...syntheticSpeech({ synthesis: { async *stream(text) { shared.spoken.push(text); yield new Uint8Array(640); } },
      transcriptionFactory: sessionId => ({ accept: async () => ok([]), flush: async generation => ok([{ kind: "segmentFinal", sessionId, generation, utteranceId: "compiled-outgoing-one", text: callerCanary, quality: "clear" }]) }) }),
    session(ledger, receipt, sessionId, playback, _signal, original) {
      assert.equal(outboundLaunchAttemptDigest(original.attempt), outboundLaunchAttemptDigest(f.retained().attempt));
      shared.created++; shared.owners.push({ ledger, receipt });
      return new VoiceSession(receipt.callId, sessionId, receipt.scope, ledger,
        new TextReception(ledger, withApprovedSyntheticVoice(new MemoryPolicyStore()), new DisabledStandaloneHost()), playback,
        async turn => { shared.turns.push(turn.text); return ok({ kind: "clarify" }); });
    } });
  const router = new TwilioOutboundIngress({ runtime, authority: { allows: async q => allowed(q), current: allowed },
    sessionEffects: (scope, owner) => new PostgresOutboundEffectBarrier(db, scope, owner),
    async createCall(...args) {
      const owned = await conversation(...args);
      let done!: () => void;
      shared.disposed.push(new Promise<void>(resolve => { done = resolve; }));
      return { receive: owned.receive, async disconnect() { try { return await owned.disconnect(); } finally { done(); } } };
    } });
  const ingress = new TwilioSignedIngress({ accountSid: config.accountSid, authToken: config.authToken,
    publicWebhookUrl: "https://clinic.example.invalid/inbound", publicStreamUrl: "wss://clinic.example.invalid/inbound/stream",
    fallbackNumbers: { [config.from]: "+61255550999" }, bindingKey: new Uint8Array(32).fill(9), now: () => new Date(f.state.now) });
  return { ...await listenTwilioOutboundTest(createTwilioIngressServer({ ingress, outbound: router, async createCall() { throw Error("No inbound owner"); } }), setup(f)), shared, runtime };
}
async function retained(f: Fixture) {
  const { sessionActionRef, reportActionRef } = f.recover().call.context;
  const barriers = await sql<{ effect_ref: string }>`select effect_ref from outbound_effect_barriers where tenant_id=${f.scope.tenantId}`.execute(db);
  assert.equal(barriers.rows.filter(row => row.effect_ref === sessionActionRef).length, 1);
  assert.equal(barriers.rows.filter(row => row.effect_ref === reportActionRef).length, 0);
  const holds = await sql`select allocation_ref from outbound_capacity_allocations where tenant_id=${f.scope.tenantId} and released_at is null`.execute(db);
  assert.equal(holds.rows.length, 2); assert.equal(f.requests, 1); assert.equal(f.posts, 1); assert.ok(f.claims <= 180); await privacy(db, f, [callerCanary]);
}
test("actual emitted conversation and native180 SQL claim allow one greeting across peers, then refuse cold replay without a final report", { timeout: 40000 }, async t => {
  const f = await fixture(); t.after(f.close); assert.equal(value(await f.launch()).kind, "accepted");
  const shared = state(), one = await server(f, shared), two = await server(f, shared); t.after(one.close); t.after(two.close);
  const [a, b] = await Promise.all([one.post(), two.post()]);
  const [wa, wb] = await Promise.all([one.open(await a.text()), two.open(await b.text())]);
  const received = new Map([[wa.socket, [] as Record<string, unknown>[]], [wb.socket, [] as Record<string, unknown>[]]]);
  for (const wire of [wa, wb]) wire.socket.on("message", raw => received.get(wire.socket)!.push(JSON.parse(raw.toString())));
  const outcomes = await Promise.all([wa.outcome, wb.outcome]);
  assert.deepEqual([...outcomes].sort(), ["closed", "ready"]);
  const winner = outcomes[0] === "ready" ? wa : wb, packets = received.get(winner.socket)!;
  while (!packets.some(message => message.event === "mark")) await once(winner.socket, "message");
  assert.equal(shared.created, 1); assert.deepEqual(shared.spoken, [f.conversationApproval.policy.greeting!.approvedText]);
  const owner = shared.owners[0]!; assert.equal(owner.receipt.admission.direction, "outbound");
  const read = value(await owner.ledger.read(owner.receipt.callId, f.scope)); assert.equal(read.lifecycle, "active");
  assert.equal("dialedNumber" in read.admission!, false); assert.equal(Object.keys(read.actions).length, 0);
  const greetingMark = packets.find(message => message.event === "mark")!.mark as { name: string };
  const followup = new Promise<void>((resolve, reject) => {
    winner.socket.on("message", raw => {
      const message = JSON.parse(raw.toString()) as { event?: string; mark?: { name?: string } };
      if (message.event === "mark" && message.mark?.name !== greetingMark.name) resolve();
    });
    winner.socket.once("close", () => reject(Error("Synthetic compiled reply unavailable")));
  });
  winner.socket.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid: setup(f).streamSid, mark: greetingMark }));
  for (let index = 0; index < 7; index++) winner.socket.send(JSON.stringify({ event: "media", sequenceNumber: String(index + 3), streamSid: setup(f).streamSid,
    media: { track: "inbound", chunk: String(index + 1), timestamp: String(index * 20), payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }));
  await followup;
  assert.deepEqual(shared.turns, [callerCanary]); assert.equal(shared.spoken.length, 2);
  const afterTurn = value(await owner.ledger.read(owner.receipt.callId, f.scope)); assert.equal(afterTurn.processedTurnIds.length, 1);
  assert.equal(Object.keys(afterTurn.actions).length, 0); assert.equal(shared.spoken.join(" ").includes(callerCanary), false);
  await one.close(); await two.close(); await Promise.all(shared.disposed); assert.equal((await owner.ledger.read(owner.receipt.callId, f.scope)).ok, false, "transient state is disposed");
  const cold = await server(f); t.after(cold.close); const response = await cold.post(), replay = await cold.open(await response.text());
  assert.equal(await replay.outcome, "closed"); assert.equal(cold.shared.created, 0);
  assert.deepEqual(await cold.runtime.inspectTerminal(), { kind: "unknown" }); await retained(f);
});
test("actual emitted conversation rechecks independent approval after a blocked policy read and opens no speech", { timeout: 40000 }, async t => {
  const f = await fixture(); t.after(f.close); assert.equal(value(await f.launch()).kind, "accepted");
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const shared = state(), live = await server(f, shared, async () => { entered(); await gate; }); t.after(live.close);
  const response = await live.post(), wire = await live.open(await response.text()); await waiting; shared.current = false; release();
  assert.equal(await wire.outcome, "closed"); assert.equal(shared.created, 0); assert.deepEqual(shared.spoken, []); await retained(f);
});

test("actual compiled conversation SIGKILL after greeting audio cannot replay or persist private native/provider context", { timeout: 40000 }, async t => {
  const f = await fixture(); t.after(f.close); assert.equal(value(await f.launch()).kind, "accepted");
  const cwd = await mkdtemp(join(tmpdir(), "abby-outbound-conversation-empty-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const child = fork(new URL("../support/outbound-conversation-worker.mjs", import.meta.url), [], { cwd, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" } });
  const output: string[] = []; child.stdout?.on("data", data => output.push(String(data))); child.stderr?.on("data", data => output.push(String(data)));
  let ready!: (port: number) => void, killed = false;
  const port = new Promise<number>(resolve => { ready = resolve; });
  child.on("message", (message: { kind?: string; port?: number }) => { if (message.kind === "ready" && message.port) ready(message.port); });
  const terminal = once(child, "close");
  const failed = new Promise<never>((_resolve, reject) => { child.once("error", reject); child.once("exit", () => { if (!killed) reject(Error("Synthetic conversation child exited early")); }); });
  const kill = async () => { if (child.exitCode === null && child.signalCode === null) { killed = true; assert.equal(child.kill("SIGKILL"), true); }
    const [, signal] = await terminal; assert.equal(signal, "SIGKILL"); };
  t.after(kill);
  child.send({ config: { ...f.twilioConfig, contextKey: Array.from(f.twilioConfig.contextKey) }, scope: f.scope, approval: f.conversationApproval,
    attemptDigest: outboundLaunchAttemptDigest(f.retained().attempt), now: f.state.now });
  const client = twilioOutboundTestClient(`http://127.0.0.1:${await Promise.race([port, failed])}`, setup(f)); t.after(client.terminate);
  const answer = await client.post(); assert.equal(answer.status, 200); const wire = await client.open(await answer.text());
  const firstMessage = once(wire.socket, "message");
  assert.equal(await Promise.race([wire.outcome, failed]), "ready");
  const [audio] = await firstMessage;
  assert.equal(JSON.parse(audio.toString()).event, "media", "actual emitted greeting audio reaches the signed socket before process loss");
  await kill(); assert.deepEqual(output, []); assert.deepEqual(await readdir(cwd), []);
  const cold = await server(f); t.after(cold.close); const response = await cold.post(), replay = await cold.open(await response.text());
  assert.equal(await replay.outcome, "closed"); assert.equal(cold.shared.created, 0);
  assert.deepEqual(await cold.runtime.inspectTerminal(), { kind: "unknown" }); await retained(f);
});
