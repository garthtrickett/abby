import assert from "node:assert/strict";
import test from "node:test";
import { TwilioMediaStream } from "../../src/voice/twilio-media-stream.ts";
import { SyntheticPlaybackReceipts } from "../support/synthetic-playback-receipts.ts";

const accountSid = `AC${"1".repeat(32)}`, callSid = `CA${"2".repeat(32)}`, streamSid = `MZ${"3".repeat(32)}`;
function fixture() {
  let sequence = 2;
  const completions: string[] = [], echoed: string[] = [];
  const peer = new SyntheticPlaybackReceipts(name => {
    echoed.push(name);
    const received = stream.receive(JSON.stringify({ event: "mark", sequenceNumber: String(sequence++), streamSid, mark: { name } }));
    assert.ok(received.ok); completions.push(received.value.kind);
  });
  const stream = new TwilioMediaStream({ accountSid, callSid, sessionId: "synthetic", startedAt: "2026-10-04T06:00:00.000Z",
    send(json) { queueMicrotask(() => peer.receive(JSON.parse(json))); return "queued"; } });
  assert.ok(stream.receive(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" })).ok);
  assert.ok(stream.receive(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
    start: { accountSid, callSid, streamSid, tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } })).ok);
  const queue = async (id: string) => {
    const signal = new AbortController().signal;
    assert.equal(await stream.queueChunk(id, 0, new Uint8Array(640), signal), "queued");
    assert.equal(await stream.finishQueue(id, 0, signal), "queued");
  };
  return { stream, peer, queue, completions, echoed };
}

test("E2E-130 synthetic caller releases a real clear fence without claiming interrupted speech played", async () => {
  const f = fixture(); await f.queue("old");
  assert.equal(f.peer.count, 1); assert.equal(f.peer.hasPendingAfter(), true);
  assert.equal(await f.stream.clear("old"), true);
  assert.deepEqual(f.completions, ["ignoredMark", "ignoredMark"]);
  assert.equal(f.peer.hasPendingAfter(), false);
  const before = f.peer.count;
  await f.queue("new"); assert.equal(f.peer.hasPendingAfter(before), true);
  assert.equal(f.peer.acknowledgeLatest(), true);
  assert.equal(f.completions.at(-1), "played");
  assert.equal(f.peer.acknowledgeLatest(), false);
  assert.equal(new Set(f.echoed).size, f.echoed.length, "no played or cleared mark can be returned twice");
});

test("a prior prompt cannot satisfy a later synthetic response's playback boundary", async () => {
  const f = fixture(); await f.queue("old");
  const before = f.peer.count;
  assert.equal(f.peer.hasPendingAfter(), true);
  assert.equal(f.peer.hasPendingAfter(before), false, "speech IPC alone has no new wire receipt");
  assert.equal(f.peer.acknowledgeLatest(), true);
  await f.queue("new");
  assert.equal(f.peer.hasPendingAfter(before), true);
  assert.equal(f.peer.acknowledgeLatest(), true);
  assert.deepEqual(f.completions, ["played", "played"]);
});

test("clear echoes only outstanding receipts when an older prompt was already played", async () => {
  const f = fixture(); await f.queue("played"); assert.equal(f.peer.acknowledgeLatest(), true);
  await f.queue("interrupted"); assert.equal(await f.stream.clear("interrupted"), true);
  assert.deepEqual(f.completions, ["played", "ignoredMark", "ignoredMark"]);
  assert.equal(new Set(f.echoed).size, f.echoed.length);
  assert.equal(f.peer.hasPendingAfter(), false);
});

test("a newly played reply remains observable after its pending receipt is consumed", async () => {
  const f = fixture();
  await f.queue("first"); assert.equal(f.peer.acknowledgeLatest(), true);
  const before = f.peer.count;
  await f.queue("new"); assert.equal(f.peer.acknowledgeLatest(), true);
  assert.equal(f.peer.hasPendingAfter(before), false);
  assert.equal(f.peer.hasReplyAfter(before), true);
  assert.equal(await f.stream.clear("new"), true);
  assert.equal(f.peer.hasReplyAfter(before), true, "a later clear cannot erase an already played reply");
});

test("clear-returned completion and fence marks never become a fresh reply", async () => {
  const f = fixture(), before = f.peer.count;
  await f.queue("unplayed"); assert.equal(await f.stream.clear("unplayed"), true);
  assert.equal(f.peer.hasReplyAfter(before), false);
  await f.queue("fresh"); assert.equal(f.peer.hasReplyAfter(before), true);
});
