import assert from "node:assert/strict";
import test, { after } from "node:test";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { intakeDeferred } from "../support/intake-edge.ts";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL);
after(() => db.destroy());
const emitted = new URL("../../dist/runtime/", import.meta.url);
const { outboundConversationFixture } = await import(new URL("test/support/twilio-outbound-conversation.js", emitted).href) as typeof import("../support/twilio-outbound-conversation.ts");
const { PostgresOutboundEffectBarrier } = await import(new URL("src/storage/postgres-outbound-effect-barrier.js", emitted).href) as typeof import("../../src/storage/postgres-outbound-effect-barrier.ts");

for (const held of [false, true])
test(`actual emitted prepared private input retains SQL session exclusion and complete privacy: ${held ? "cancelled during preparation" : "accepted input"}`, { timeout: 20000 }, async t => {
  const release = intakeDeferred<void>(), entered = intakeDeferred<void>(), stopped = intakeDeferred<void>(), accepted = intakeDeferred<void>();
  let preparations = 0, digits = "", stops = 0, sessionId = "";
  const privateDigits = "73194628510478253690";
  const f = await outboundConversationFixture({
    identities: { accountSid: `AC${randomUUID().replaceAll("-", "")}`, callSid: `CA${randomUUID().replaceAll("-", "")}`,
      streamSid: `MZ${randomUUID().replaceAll("-", "")}`, authToken: `synthetic-prepared-${randomUUID()}`, contextKey: randomBytes(32),
      patientId: String(randomInt(1_000_000_000_000, 9_999_999_999_999)), nativeRecallId: String(randomInt(1_000_000_000_000, 9_999_999_999_999)),
      recipientNumber: `+614${randomInt(10_000_000, 99_999_999)}` },
    sessionEffects: (scope, binding) => new PostgresOutboundEffectBarrier(db, scope, binding),
    prepare: async (context, create) => {
      preparations++; sessionId = context.sessionId; entered.resolve();
      if (held) await release.promise;
      let claimed = false, answered = false, closed = false;
      return { create, privateKeypadInput: {
        claim: (_call, id) => { if (claimed || id !== context.sessionId) return false; claimed = true; return true; },
        start: () => claimed && !closed,
        blocked: () => !answered || closed,
        accept: async digit => {
          if (closed) return "failed";
          if (digit === "#") { answered = true; accepted.resolve(); return "verified"; }
          digits += digit; return "pending";
        }, stop: () => { stops++; closed = true; stopped.resolve(); },
      } };
    },
  });
  const server = await f.listen(); t.after(server.close); t.after(() => release.resolve());
  const response = await server.post(), wire = await server.open(await response.text());
  const output: unknown[] = [];
  wire.socket.on("message", raw => { output.push(JSON.parse(raw.toString())); });
  await entered.promise;
  if (!held) {
    assert.equal(await wire.outcome, "ready");
    while (!(output as { event?: string }[]).some(m => m.event === "mark")) await once(wire.socket, "message");
    let sequence = 1;
    const mark = (output as { event?: string; mark?: unknown }[]).find(m => m.event === "mark")!.mark;
    wire.socket.send(JSON.stringify({ event: "mark", streamSid: f.streamSid, sequenceNumber: String(++sequence), mark }));
    for (const digit of privateDigits + "#") wire.socket.send(JSON.stringify({ event: "dtmf", streamSid: f.streamSid,
      sequenceNumber: String(++sequence), dtmf: { track: "inbound_track", digit } }));
    await accepted.promise; assert.equal(digits, privateDigits);
    assert.deepEqual(f.acceptedTranscripts, []); assert.deepEqual(f.turns, []);
  }
  const peer = await f.listen(f.makeRouter()); t.after(peer.close);
  const peerResponse = await peer.post(), duplicate = await peer.open(await peerResponse.text());
  assert.equal(await duplicate.outcome, "closed"); assert.equal(preparations, 1);
  const closed = once(wire.socket, "close"); wire.socket.close(); await closed;
  release.resolve(); await stopped.promise;
  assert.equal(stops, 1); assert.equal(f.opened, held ? 0 : 1);
  const canaries = [privateDigits, sessionId, f.callSid, f.streamSid, f.config.accountSid, f.config.authToken,
    Buffer.from(f.config.contextKey).toString("hex"), Buffer.from(f.config.contextKey).toString("base64"),
    JSON.stringify(f.original), f.original.recallRef, f.original.attempt.patientId, f.original.attempt.requestDigest,
    f.call.number, f.form.toString()];
  const probes = canaries.flatMap((text, i) => Array.from({ length: Math.ceil(text.length / 256) }, (_, part) => {
    const chunk = text.slice(part * 256, (part + 1) * 256); return { label: `prepared_input_${i}_${part}`, value: chunk.length < 4 ? text.slice(-4) : chunk };
  }));
  for (let i = 0; i < probes.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, probes.slice(i, i + 12)), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [process.env.DATABASE_URL!, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  const copy = (v: string) => v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
  for (const text of canaries) {
    const json = JSON.stringify(text).slice(1, -1);
    for (const variant of [text, copy(text), json, copy(json)]) assert.equal(dump.includes(variant), false);
  }
  for (const value of [privateDigits, ...canaries.slice(4)]) assert.equal(JSON.stringify([output, f.spoken, f.acceptedTranscripts, f.turns]).includes(value), false);
});
