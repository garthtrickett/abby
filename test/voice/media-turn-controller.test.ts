import assert from "node:assert/strict";
import test from "node:test";
import { err, ok } from "../../src/core/model.ts";
import { MediaTurnController } from "../../src/voice/media-turn-controller.ts";
import type { MediaFrame, TranscriptionPort } from "../../src/voice/media-turn-controller.ts";
import { TurnAssembler } from "../../src/voice/turn-assembler.ts";

const start = Date.parse("2026-09-28T10:00:00.000Z");

function frame(sequence: number, amplitude: number, sessionId = "session"): MediaFrame {
  const bytes = new Uint8Array(640);
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, amplitude, true);
  return { sessionId, sequence, capturedAt: new Date(start + sequence * 20).toISOString(), bytes };
}

test("PCM frames trigger Abby speech onset and silence endpointing before a final turn", async () => {
  const assembler = new TurnAssembler("call", "session");
  const accepted: number[] = [];
  let finished = 0;
  const target = {
    async speechStarted() { return ok(assembler.beginSpeech()); },
    acceptTranscript: assembler.accept.bind(assembler),
    async finishTurn(now: string) { finished += 1; return assembler.finish(now); },
  };
  const transcription: TranscriptionPort = {
    async accept(media, generation) {
      accepted.push(media.sequence);
      return ok(media.sequence === 0 ? [{ kind: "partial" as const, sessionId: "session", generation,
        utteranceId: "one", text: "Book" }] : []);
    },
    async flush(generation) { return ok([{ kind: "segmentFinal", sessionId: "session", generation,
      utteranceId: "one", text: "Book physio", quality: "clear" }]); },
  };
  const media = new MediaTurnController("session", target, transcription, { silenceMs: 100 });
  assert.equal(value(await media.acceptMedia(frame(0, 2_000))).kind, "listening");
  assert.equal(accepted.length, 0);
  assert.equal(value(await media.acceptMedia(frame(1, 2_000))).kind, "speaking");
  assert.deepEqual(accepted, [0, 1]);
  for (let sequence = 2; sequence < 6; sequence += 1) {
    assert.equal(value(await media.acceptMedia(frame(sequence, 0))).kind, "speaking");
    assert.equal(finished, 0);
  }
  const completed = value(await media.acceptMedia(frame(6, 0)));
  assert.equal(completed.kind, "turnCompleted");
  if (completed.kind !== "turnCompleted") throw new Error("turn expected");
  assert.equal(completed.value.text, "Book physio");
  assert.equal(finished, 1);
  assert.deepEqual(accepted, [0, 1, 2, 3, 4, 5, 6]);
  await media.stop();
  assert.equal((await media.acceptMedia(frame(7, 2_000))).ok, false);
});

function value<T>(result: { ok: true; value: T } | { ok: false; error: { kind: string } }): T {
  assert.ok(result.ok, result.ok ? "" : result.error.kind);
  return result.value;
}

test("media input rejects malformed and out-of-order frames without consuming their sequence", async () => {
  const accepted: number[] = [];
  const media = new MediaTurnController("session", {
    async speechStarted() { return ok(1); },
    acceptTranscript() { return ok(undefined); },
    async finishTurn() { return ok("done"); },
  }, {
    async accept(input) { accepted.push(input.sequence); return ok([]); },
    async flush() { return ok([]); },
  });
  const wrongSession = await media.acceptMedia(frame(0, 2_000, "foreign"));
  assert.ok(!wrongSession.ok);
  assert.equal(wrongSession.error.kind, "invalidMedia");
  const gap = await media.acceptMedia(frame(1, 2_000));
  assert.ok(!gap.ok);
  assert.equal(gap.error.kind, "mediaOutOfOrder");
  const malformed = await media.acceptMedia({ ...frame(0, 2_000), bytes: new Uint8Array(639) });
  assert.ok(!malformed.ok);
  assert.equal(malformed.error.kind, "invalidMedia");
  value(await media.acceptMedia(frame(0, 2_000)));
  value(await media.acceptMedia(frame(1, 2_000)));
  assert.deepEqual(accepted, [0, 1]);
});

test("bounded media queue applies backpressure and copies frames before asynchronous transcription", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const accepted: number[] = [];
  const media = new MediaTurnController("session", {
    async speechStarted() { return ok(1); },
    acceptTranscript() { return ok(undefined); },
    async finishTurn() { return ok("done"); },
  }, {
    async accept(input) { await gate; accepted.push(new DataView(input.bytes.buffer).getInt16(0, true)); return ok([]); },
    async flush() { return ok([]); },
  }, { speechStartMs: 20, maxQueuedFrames: 1 });
  const original = frame(0, 2_000);
  const first = media.acceptMedia(original);
  original.bytes.fill(0);
  const overloaded = await media.acceptMedia(frame(1, 2_000));
  assert.ok(!overloaded.ok);
  assert.equal(overloaded.error.kind, "mediaOverloaded");
  release();
  value(await first);
  value(await media.acceptMedia(frame(1, 2_000)));
  assert.deepEqual(accepted, [2_000, 2_000]);
});

test("transcription failure and overlong speech stop media before any final turn", async () => {
  let finished = 0;
  const target = {
    async speechStarted() { return ok(1); },
    acceptTranscript() { return ok(undefined); },
    async finishTurn() { finished += 1; return ok("done"); },
  };
  const failed = new MediaTurnController("session", target, {
    async accept() { return err({ kind: "transcriptionUnavailable" as const }); },
    async flush() { return ok([]); },
  }, { speechStartMs: 20 });
  const rejection = await failed.acceptMedia(frame(0, 2_000));
  assert.ok(!rejection.ok);
  assert.equal(rejection.error.kind, "transcriptionUnavailable");
  assert.equal((await failed.acceptMedia(frame(1, 2_000))).ok, false);
  assert.equal(finished, 0);

  const long = new MediaTurnController("session", target, {
    async accept() { return ok([]); },
    async flush() { return ok([]); },
  }, { speechStartMs: 20, maxTurnMs: 1_000 });
  for (let sequence = 0; sequence < 50; sequence += 1) value(await long.acceptMedia(frame(sequence, 2_000)));
  const overlong = await long.acceptMedia(frame(50, 2_000));
  assert.ok(!overlong.ok);
  assert.equal(overlong.error.kind, "turnTooLong");
  assert.equal(finished, 0);
});

test("a stalled transcription adapter receives abort and cannot hold the media queue open", async () => {
  let aborted = false;
  const media = new MediaTurnController("session", {
    async speechStarted() { return ok(1); },
    acceptTranscript() { return ok(undefined); },
    async finishTurn() { throw new Error("unfinished speech cannot become a turn"); },
  }, {
    async accept(_frame, _generation, signal) {
      return new Promise(resolve => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve(err({ kind: "transcriptionUnavailable" as const }));
        }, { once: true });
      });
    },
    async flush() { return ok([]); },
  }, { speechStartMs: 20, transcriptionDeadlineMs: 50 });
  const failed = await media.acceptMedia(frame(0, 2_000));
  assert.ok(!failed.ok);
  assert.equal(failed.error.kind, "transcriptionUnavailable");
  assert.equal(aborted, true);
  await media.stop();
});

test("stopping active media aborts transcription and cancels its generation", async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let aborted = false;
  const canceled: number[] = [];
  const media = new MediaTurnController("session", {
    async speechStarted() { return ok(7); },
    acceptTranscript() { return ok(undefined); },
    async finishTurn() { return ok("unexpected"); },
  }, {
    async accept(_frame, _generation, signal) {
      entered();
      return new Promise(resolve => signal.addEventListener("abort", () => {
        aborted = true;
        resolve(err({ kind: "transcriptionUnavailable" as const }));
      }, { once: true }));
    },
    async flush() { return ok([]); },
    async cancel(generation) { canceled.push(generation); },
  }, { speechStartMs: 20, transcriptionDeadlineMs: 5_000 });
  const frameResult = media.acceptMedia(frame(0, 2_000));
  await started;
  await media.stop();
  assert.equal(aborted, true);
  assert.deepEqual(canceled, [7]);
  const result = await frameResult;
  assert.ok(!result.ok);
  assert.equal(result.error.kind, "transcriptionUnavailable");
});

test("a target exception closes media with a target failure", async () => {
  const media = new MediaTurnController("session", {
    async speechStarted() { throw new Error("target offline"); },
    acceptTranscript() { return ok(undefined); },
    async finishTurn() { return ok("unexpected"); },
  }, {
    async accept() { return ok([]); },
    async flush() { return ok([]); },
  }, { speechStartMs: 20 });
  const failed = await media.acceptMedia(frame(0, 2_000));
  assert.ok(!failed.ok);
  assert.equal(failed.error.kind, "targetUnavailable");
  const next = await media.acceptMedia(frame(1, 2_000));
  assert.ok(!next.ok);
  assert.equal(next.error.kind, "mediaClosed");
});

test("a stalled transcription cancellation cannot hold disconnect open", async () => {
  const media = new MediaTurnController("session", {
    async speechStarted() { return ok(3); },
    acceptTranscript() { return ok(undefined); },
    async finishTurn() { return ok("unexpected"); },
  }, {
    async accept() { return ok([]); },
    async flush() { return ok([]); },
    async cancel() { return new Promise<void>(() => {}); },
  }, { speechStartMs: 20, transcriptionDeadlineMs: 50 });
  value(await media.acceptMedia(frame(0, 2_000)));
  const startedAt = Date.now();
  await media.stop();
  assert.ok(Date.now() - startedAt < 1_000);
});

test("pre-location and scoped turns have distinct IDs even with the same session and utterance ID", () => {
  const pre = new TurnAssembler("call", "session", "prelocation");
  const scoped = new TurnAssembler("call", "session");
  for (const assembler of [pre, scoped]) {
    const generation = assembler.beginSpeech();
    value(assembler.accept({ kind: "segmentFinal", sessionId: "session", generation,
      utteranceId: "provider-utterance-one", text: "Northside", quality: "clear" }));
  }
  assert.notEqual(value(pre.finish(new Date(start).toISOString())).turnId,
    value(scoped.finish(new Date(start).toISOString())).turnId);
});
