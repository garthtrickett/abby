import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { outboundContactLifecycleFixture } from "../support/outbound-contact-lifecycle.ts";
import { outboundLaunchPeer } from "../support/outbound-one-shot-launch-peer.ts";
import { value } from "../support/outbound-records.ts";
import { outboundLaunchAttemptDigest } from "../../src/cliniko/outbound-launch-attempt.ts";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL); after(() => db.destroy());
const emitted = new URL("../../dist/runtime/src/", import.meta.url);
const { ClinikoOutboundLaunchOwner } = await import(new URL("standalone/cliniko-outbound-launch-owner.js", emitted).href) as typeof import("../../src/standalone/cliniko-outbound-launch-owner.ts");
const { OwnerFileOutboundCampaign } = await import(new URL("standalone/owner-file-outbound-campaign.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-campaign.ts");
const { OwnerFileOutboundContactAccount } = await import(new URL("standalone/owner-file-outbound-contact-account.js", emitted).href) as typeof import("../../src/standalone/owner-file-outbound-contact-account.ts");
const { PostgresOutboundCapacity } = await import(new URL("storage/postgres-outbound-capacity.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-capacity.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");
const { outboundContactGuardOwnerBinding } = await import(new URL("core/outbound-capacity.js", emitted).href) as typeof import("../../src/core/outbound-capacity.ts");
const { TwilioAbbyOutboundRuntime } = await import(new URL("voice/twilio-outbound-runtime.js", emitted).href) as typeof import("../../src/voice/twilio-outbound-runtime.ts");
const { bindOutboundVoiceRuntime } = await import(new URL("voice/outbound-runtime.js", emitted).href) as typeof import("../../src/voice/outbound-runtime.ts");

async function fixture(mode: "accepted" | "lostAck" | "foreignAck" = "accepted") {
  const apiKey = `synthetic-twilio-${randomUUID()}-au5`, scope = { tenantId: `twilio-${randomUUID()}`, clinicId: "clinic", locationId: "one" }, guardRef = randomUUID();
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
  const contactCapacity = new PostgresOutboundCapacity(db, scope, outboundContactGuardOwnerBinding(guardRef)!);
  const f = await outboundContactLifecycleFixture({ apiKey, scope, guardRef, budget, capacity: contactCapacity,
    runtime: { ClinikoOutboundLaunchOwner, OwnerFileOutboundCampaign, OwnerFileOutboundContactAccount },
    effectFactory: (s, b) => new PostgresOutboundEffectBarrier(db, s, b), capacityFactory: (s, b) => new PostgresOutboundCapacity(db, s, b) });
  const config = { ref: f.controls.providerRef, profileRef: "generic-clinic-greeting", accountSid: `AC${"a".repeat(32)}`, authToken: "synthetic-twilio-auth",
    from: "+61255550100", publicAnswerUrl: "https://clinic.example.invalid/outbound/answer", publicStatusUrl: "https://clinic.example.invalid/outbound/status",
    publicStreamUrl: "wss://clinic.example.invalid/outbound/stream", contextKey: new Uint8Array(32).fill(7) };
  let requests = 0, form!: URLSearchParams; const callSid = `CA${"b".repeat(32)}`;
  const transport: typeof fetch = async (input, init) => {
    assert.equal(String(input), `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls.json`);
    assert.equal(init?.method, "POST"); assert.equal(init.redirect, "error"); requests++; form = new URLSearchParams(String(init.body));
    assert.equal(form.get("To"), f.request.recipient.number);
    assert.equal(new Headers(init.headers).get("Authorization"), `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`);
    assert.equal(f.posts, 1); assert.equal(f.retained().attempt.effectRef, f.request.effectRef);
    const holds = (await sql`select allocation_ref from outbound_capacity_allocations where tenant_id=${scope.tenantId} and released_at is null`.execute(db)).rows;
    assert.equal(holds.length, 2);
    if (mode === "lostAck") throw Error("Synthetic private provider ACK lost");
    return Response.json({ account_sid: config.accountSid, sid: callSid, to: mode === "foreignAck" ? "+61455550999" : form.get("To"),
      from: config.from, direction: "outbound-api", parent_call_sid: null, status: "queued",
      uri: `/2010-04-01/Accounts/${config.accountSid}/Calls/${callSid}.json` }, { status: 201 });
  };
  const makeRuntime = () => new TwilioAbbyOutboundRuntime({ ...config, now: () => f.state.now }, transport);
  const runtime = value(bindOutboundVoiceRuntime(makeRuntime()));
  const owner = value(ClinikoOutboundLaunchOwner.create(f.config, { ...f.ports, provider: runtime.launch }));
  const recover = () => {
    const cold = makeRuntime(), url = new URL(form.get("Url")!);
    const fields = { AccountSid: config.accountSid, CallSid: callSid, From: config.from, To: f.request.recipient.number, Direction: "outbound-api", CallStatus: "in-progress" };
    return value(cold.authenticateAnswer({ method: "POST", requestTarget: url.pathname + url.search, contentType: "application/x-www-form-urlencoded",
      signature: getExpectedTwilioSignature(config.authToken, url.href, fields), body: new URLSearchParams(fields).toString() }));
  };
  return { ...f, scope, apiKey, twilioConfig: config, transport, owner, recover, get requests() { return requests; }, get form() { return form; },
    get posts() { return f.posts; }, get claims() { return f.claims; },
    launch: () => owner.launchOnce(f.binding, new AbortController().signal) };
}
async function privacy(f: Awaited<ReturnType<typeof fixture>>) {
  const { row, attempt } = f.retained();
  const markers = [f.apiKey, f.twilioConfig.authToken, f.request.recipient.number, "cliniko:recall:30", "Abby possible outbound launch v4"];
  assert.deepEqual(await scanPatientDataCanaries(db, markers.map((value, i) => ({ label: `twilio_${i}`, value }))), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  const token = new URL(f.form.get("Url")!).searchParams.get("abbyContext")!;
  for (const marker of [...markers, String(row.notes), String(f.requestRow.notes), outboundLaunchAttemptDigest(attempt)!, token, f.form.toString()]) assert.equal(dump.includes(marker), false);
}
for (const mode of ["accepted", "lostAck", "foreignAck"] as const)
  test(`emitted Twilio + real native180 SQL launch holds and cold original binding: ${mode}`, { timeout: 30000 }, async t => {
    const f = await fixture(mode); t.after(f.close);
    assert.deepEqual(value(await f.launch()), { kind: mode === "accepted" ? "accepted" : "unknown", capacity: "held" });
    assert.equal(f.requests, 1); assert.equal(f.posts, 1); assert.ok(f.claims <= 180);
    const cold = f.recover(), { attempt } = f.retained();
    assert.equal(cold.call.context.attemptDigest, outboundLaunchAttemptDigest(attempt));
    const rows = (await sql`select allocation_ref from outbound_capacity_allocations where tenant_id=${f.scope.tenantId} and released_at is null`.execute(db)).rows;
    assert.equal(rows.length, 2); assert.equal((await f.launch()).ok, false); assert.equal(f.requests, 1);
    await privacy(f);
  });
test("actual emitted Twilio owner killed after one submission cold-recovers sealed original context without replay or a private file/SQL map", { timeout: 30000 }, async t => {
  const f = await fixture(); t.after(f.close); const cwd = await mkdtemp(join(tmpdir(), "abby-twilio-owner-empty-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  let submitted!: () => void; const began = new Promise<void>(r => { submitted = r; });
  const peer = await outboundLaunchPeer(f, cwd, submitted, "provider", undefined, { guardRef: f.guardRef, accountPath: f.captureConfig.path,
    maximumNativeRequests: 20, numberStops: f.ports.numberStops, native: f.native, twilio: { config: f.twilioConfig, transport: f.transport } }); t.after(peer.kill);
  await Promise.race([began, peer.errors, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(Error("Synthetic Twilio submission not reached")), 20000); t.after(() => clearTimeout(timer)); })]);
  await peer.kill(); assert.deepEqual(peer.output, []); assert.deepEqual(await readdir(cwd), []);
  const cold = f.recover(), { attempt } = f.retained(); assert.equal(f.requests, 1); assert.equal(cold.call.context.attemptDigest, outboundLaunchAttemptDigest(attempt));
  const rows = (await sql`select allocation_ref from outbound_capacity_allocations where tenant_id=${f.scope.tenantId} and released_at is null`.execute(db)).rows;
  assert.equal(rows.length, 2); assert.equal((await f.launch()).ok, false); assert.equal(f.requests, 1); await privacy(f);
});
