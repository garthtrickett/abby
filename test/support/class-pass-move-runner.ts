import assert from "node:assert/strict";
import type { withClinicalRunner } from "./clinical-runner-call.ts";
import { verificationCanaries } from "./caller-verification.ts";
type Call = Parameters<Parameters<typeof withClinicalRunner>[1]>[0];
export async function prepareClassPassMove(call: Call, transfer: boolean) {
  await call.say("Start"); await call.mark(); await call.verify();
  await call.say("Appointments"); await call.mark(); await call.say("The first time please."); await call.mark();
  await call.say("Times"); await call.mark(); await call.say("The first time please.");
  assert.match(call.spoken.at(-1)!, transfer ? /original pass releases one session.*destination pass uses one session/ : /pass session use unchanged/);
  assert.match(call.spoken.at(-1)!, /staff may need to confirm the replacement/);
  assert.equal(call.mutations.length, 0); await call.mark();
}
export async function affirmClassPassMove(call: Call) {
  await call.say("Yes");
  const match = /wait about (\d+) seconds/.exec(call.spoken.at(-1)!); if (!match) return;
  const seconds = Number(match[1]); assert.ok(seconds >= 1 && seconds <= 60);
  assert.match(call.spoken.at(-1)!, /say yes again/); assert.equal(call.mutations.length, 0); await call.mark();
  let ticker: ReturnType<typeof setInterval> | undefined, quiet: ReturnType<typeof setInterval> | undefined;
  try {
    ticker = setInterval(() => call.child.send({ kind: "advanceClock", milliseconds: 1000 }), 1000);
    quiet = setInterval(() => call.media(false), 20);
    await new Promise<void>(resolve => setTimeout(resolve, seconds * 1000 + 500)); assert.equal(call.mutations.length, 0);
  } finally { if (ticker) clearInterval(ticker); if (quiet) clearInterval(quiet); }
  await call.say("Yes");
}
export async function scanClassPassMovePrivacy(call: Call) {
  const code = call.messages.find(row => row.kind === "verificationEmail")!.code!;
  const secrets = [code, ...verificationCanaries, "811222333444555666", "811222333444555667",
    "private-move-source-entitlement", "private-move-destination-entitlement", "synthetic-private-move-pass-note"];
  const notes = call.mutations.find(row => row.path === "/v1/recalls")?.body?.notes;
  if (typeof notes === "string") {
    const payload = notes.split("\n").find(line => line.startsWith("z1:")); assert.ok(payload);
    secrets.push(payload);
  }
  for (const secret of secrets) assert.equal(JSON.stringify([call.spoken, call.messages.filter(row => ["modelTurn", "ordinaryFinal"].includes(row.kind))]).includes(secret), false);
  // The existing diagnostic accepts at most12 canaries of256 characters per
  // call. Scan every encoded review fragment as well as all plain canaries;
  // full payload equality above alone would miss partial storage leakage.
  const fragments = secrets.flatMap(value => value.length <= 256 ? [value] :
    Array.from({ length: Math.ceil(value.length / 200) }, (_, index) => value.slice(Math.min(index * 200, value.length - 4), index * 200 + 200)));
  for (let offset = 0; offset < fragments.length; offset += 12) await call.scan(fragments.slice(offset, offset + 12));
}
