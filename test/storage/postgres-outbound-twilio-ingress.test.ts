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
import { outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
import { postgresTwilioOutboundFixture as fixture, postgresTwilioOutboundPrivacy as privacy } from "../support/postgres-twilio-outbound.ts";
import { listenTwilioOutboundTest, twilioOutboundTestClient } from "../support/twilio-outbound-ingress.ts";
import { value } from "../support/outbound-records.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { TwilioAbbyOutboundRuntime } = await import(new URL("voice/twilio-outbound-runtime.js", emitted).href) as typeof import("../../src/voice/twilio-outbound-runtime.ts");
const { TwilioOutboundIngress } = await import(new URL("voice/twilio-outbound-ingress.js", emitted).href) as typeof import("../../src/voice/twilio-outbound-ingress.ts");
const { TwilioSignedIngress } = await import(new URL("voice/twilio-signed-ingress.js", emitted).href) as typeof import("../../src/voice/twilio-signed-ingress.ts");
const { TwilioMediaStream } = await import(new URL("voice/twilio-media-stream.js", emitted).href) as typeof import("../../src/voice/twilio-media-stream.ts");
const { createTwilioIngressServer } = await import(new URL("voice/twilio-ingress-server.js", emitted).href) as typeof import("../../src/voice/twilio-ingress-server.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
type Fixture = Awaited<ReturnType<typeof fixture>>;
const setup = (f: Fixture) => ({ config: f.twilioConfig, form: f.form, number: f.request.recipient.number,
  callSid: f.callSid, streamSid: `MZ${"c".repeat(32)}` });
async function server(f: Fixture, state = { current: true, created: 0, disconnected: 0 }) {
  const config = { ...f.twilioConfig, now: () => f.state.now }, runtime = new TwilioAbbyOutboundRuntime(config), provider = runtime.binding();
  const allowed = (q: import("../../src/voice/twilio-outbound-ingress.ts").TwilioOutboundIngressQuery) => state.current &&
    isDeepStrictEqual(q.call.context.original.attempt.scope, f.scope) && isDeepStrictEqual(q.provider, provider) &&
    q.call.context.attemptDigest === outboundLaunchAttemptDigest(f.retained().attempt);
  const router = new TwilioOutboundIngress({ runtime, authority: { allows: async q => allowed(q), current: q => allowed(q) },
    sessionEffects: (scope, owner) => new PostgresOutboundEffectBarrier(db, scope, owner),
    async createCall(stream, send) {
      state.created++;
      const media = new TwilioMediaStream({ accountSid: stream.call.accountSid, callSid: stream.call.callSid,
        sessionId: stream.call.context.sessionActionRef, startedAt: stream.streamStartedAt, send });
      return { async receive(raw) { const result = media.receive(raw);
        if (result.ok && result.value.kind === "started") send(JSON.stringify({ event: "ready" })); return { ok: result.ok }; },
      async disconnect() { state.disconnected++; media.close(); } };
    }
  });
  const ingress = new TwilioSignedIngress({ accountSid: config.accountSid, authToken: config.authToken,
    publicWebhookUrl: "https://clinic.example.invalid/inbound", publicStreamUrl: "wss://clinic.example.invalid/inbound/stream",
    fallbackNumbers: { [config.from]: "+61255550999" }, bindingKey: new Uint8Array(32).fill(9), now: () => new Date(f.state.now) });
  const raw = createTwilioIngressServer({ ingress, outbound: router, async createCall() { throw Error("No inbound owner"); } });
  return { ...await listenTwilioOutboundTest(raw, setup(f)), state, runtime, router };
}
async function retained(f: Fixture) {
  const context = f.recover().call.context;
  const session = await sql`select effect_ref from outbound_effect_barriers where tenant_id=${f.scope.tenantId} and effect_ref=${context.sessionActionRef}::uuid`.execute(db);
  const report = await sql`select effect_ref from outbound_effect_barriers where tenant_id=${f.scope.tenantId} and effect_ref=${context.reportActionRef}::uuid`.execute(db);
  const holds = await sql`select allocation_ref from outbound_capacity_allocations where tenant_id=${f.scope.tenantId} and released_at is null`.execute(db);
  assert.equal(session.rows.length, 1); assert.equal(report.rows.length, 0); assert.equal(holds.rows.length, 2);
  assert.equal(f.requests, 1); assert.equal(f.posts, 1); assert.ok(f.claims <= 180); await privacy(db, f);
}

test("actual emitted signed servers and native180 owner share one permanent SQL conversation claim with cold replay refusal", { timeout: 40_000 }, async t => {
  const f = await fixture(db); t.after(f.close); assert.equal(value(await f.launch()).kind, "accepted");
  const shared = { current: true, created: 0, disconnected: 0 }, one = await server(f, shared), two = await server(f, shared); t.after(one.close); t.after(two.close);
  const [a, b] = await Promise.all([one.post(), two.post()]); assert.equal(a.status, 200); assert.equal(b.status, 200);
  const [wa, wb] = await Promise.all([one.open(await a.text()), two.open(await b.text())]);
  assert.deepEqual((await Promise.all([wa.outcome, wb.outcome])).sort(), ["closed", "ready"]); assert.equal(shared.created, 1);
  assert.equal((await one.post("status", { CallStatus: "completed" })).status, 204);
  assert.deepEqual(await one.runtime.inspectTerminal(), { kind: "unknown" });
  await one.close(); await two.close();
  const cold = await server(f, shared); t.after(cold.close); const answer = await cold.post(), wire = await cold.open(await answer.text());
  assert.equal(await wire.outcome, "closed"); assert.equal(shared.created, 1);
  assert.equal((await f.launch()).ok, false); await retained(f);
});

test("actual emitted ingress refuses permission revoked during the real SQL session-claim lock wait", { timeout: 40_000 }, async t => {
  const f = await fixture(db); t.after(f.close); assert.equal(value(await f.launch()).kind, "accepted");
  const live = await server(f); t.after(live.close); const answer = await live.post(); assert.equal(answer.status, 200); const xml = await answer.text();
  let enter!: () => void, unlock!: () => void, blockerPid = 0;
  const ready = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { unlock = r; });
  const blocker = db.transaction().execute(async trx => {
    blockerPid = Number((await sql<{pid:number}>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid);
    await sql`select pg_advisory_xact_lock(172934501,hashtext(${f.scope.tenantId}))`.execute(trx); enter(); await gate;
  });
  let pending: Promise<unknown> = Promise.resolve();
  try {
    await ready; const wire = await live.open(xml); pending = wire.outcome;
    let waiting = false; const deadline = Date.now() + 4000;
    while (!waiting && Date.now() < deadline) {
      waiting = (await sql<{waiting:boolean}>`select exists(select 1 from pg_locks where not granted and ${blockerPid}=any(pg_blocking_pids(pid))) as waiting`.execute(db)).rows[0]!.waiting;
      if (!waiting) await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(waiting, true, "the real emitted session claim must wait on this exact transaction");
    live.state.current = false; unlock(); await blocker;
    assert.equal(await wire.outcome, "closed"); assert.equal(live.state.created, 0); await retained(f);
  } finally { unlock(); await blocker; await pending; }
});

test("actual compiled ingress SIGKILL after permanent session claim cannot restart a conversation or leave private files/SQL context", { timeout: 40_000 }, async t => {
  const f = await fixture(db); t.after(f.close); assert.equal(value(await f.launch()).kind, "accepted");
  const cwd = await mkdtemp(join(tmpdir(), "abby-outbound-ingress-empty-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const child = fork(new URL("../support/outbound-ingress-worker.mjs", import.meta.url), [], { cwd, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" } });
  const output: string[] = []; child.stdout?.on("data", d => output.push(String(d))); child.stderr?.on("data", d => output.push(String(d)));
  let ready!: (port:number) => void, constructing!: () => void, killed = false;
  const port = new Promise<number>(r => { ready = r; }), created = new Promise<void>(r => { constructing = r; });
  child.on("message", (m: any) => { if (m.kind === "ready") ready(m.port); if (m.kind === "constructing") constructing(); });
  const terminal = once(child, "close");
  const failed = new Promise<never>((_r, reject) => { child.once("error", reject); child.once("exit", () => { if (!killed) reject(Error("Synthetic ingress child exited early")); }); });
  const kill = async () => { if (child.exitCode === null && child.signalCode === null) { killed = true; assert.equal(child.kill("SIGKILL"), true); }
    const [, signal] = await terminal; assert.equal(signal, "SIGKILL"); };
  t.after(kill);
  child.send({ config: { ...f.twilioConfig, contextKey: Array.from(f.twilioConfig.contextKey) }, scope: f.scope,
    attemptDigest: outboundLaunchAttemptDigest(f.retained().attempt), now: f.state.now });
  const client = twilioOutboundTestClient(`http://127.0.0.1:${await Promise.race([port, failed])}`, setup(f)); t.after(client.terminate);
  const answer = await client.post(); assert.equal(answer.status, 200); const wire = await client.open(await answer.text());
  const outcome = wire.outcome.catch(() => "closed" as const);
  await Promise.race([created, failed]); await kill(); await outcome;
  assert.deepEqual(output, []); assert.deepEqual(await readdir(cwd), []);
  const cold = await server(f); t.after(cold.close); const recovered = await cold.post(), replay = await cold.open(await recovered.text());
  assert.equal(await replay.outcome, "closed"); assert.equal(cold.state.created, 0);
  assert.equal((await f.launch()).ok, false); await retained(f);
});
