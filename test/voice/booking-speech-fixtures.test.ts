import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { bookingCorpus, bookingSpeechPhrases, bookingSpeechVoices, buildBookingSpeechPairs, pcm16Wav } from "../../scripts/lib/booking-speech-fixtures.ts";
import { parseTranscriptionEvaluationCorpus } from "../../src/voice/transcription-evaluation.ts";
import type { SpeechSynthesisPort } from "../../src/voice/streamed-playback-port.ts";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function source(): Buffer { const pcm = Buffer.alloc(1280); for (let i = 0; i < 640; i++) pcm.writeInt16LE(Math.round(5000 * Math.sin(2 * Math.PI * i / 16)), i * 2); return pcm; }

test("E2E-161 bundled booking clips pin both voices, quiet/noisy conditions, dates, negation and duration corrections", () => {
  const root = new URL("../../eval/", import.meta.url), corpus = parseTranscriptionEvaluationCorpus(JSON.parse(readFileSync(new URL("transcription-booking-v1.json", root), "utf8")));
  assert.equal(corpus.version, "transcription-booking-v1"); assert.equal(corpus.cases.length, 16);
  for (const [i, item] of corpus.cases.entries()) {
    const phrase = bookingSpeechPhrases[Math.floor(i / 2) % 4]!, voice = bookingSpeechVoices[Math.floor(i / 8)]!, condition = i % 2 ? "noise10db" : "quiet";
    assert.equal(item.expectedText, phrase.text); assert.deepEqual(item.criticalTerms, phrase.criticalTerms);
    assert.equal(item.file, `booking-${phrase.id}-${voice}-${condition}-pcmu.pcm`);
    const pcm = readFileSync(new URL(`audio/${item.file}`, root)); assert.equal(sha(pcm), item.sha256); assert.equal(pcm.length % 640, 0); assert.ok(pcm.length <= 640_000);
  }
});

test("E2E-161 fixed booking/date/correction voices produce reproducible quiet/noisy telephone pairs and exact WAV exports", async () => {
  const requests: { text: string; voice: string }[] = [];
  const build = async () => {
    const pairs = [];
    for await (const pair of buildBookingSpeechPairs(voice => ({ async *stream(text) { requests.push({ text, voice }); yield source().subarray(0, 640); yield source().subarray(640); } }), new AbortController().signal)) pairs.push(pair);
    return pairs;
  };
  const first = await build(), second = await build(); assert.equal(first.length, 8); assert.equal(second.length, 8);
  assert.deepEqual(requests.slice(0, 8), bookingSpeechVoices.flatMap(voice => bookingSpeechPhrases.map(p => ({ text: p.text, voice }))));
  const cases = first.flatMap((pair, i) => {
    assert.equal(pair.clippedSamples, 0); assert.ok(pair.measuredSnrDb > 9 && pair.measuredSnrDb < 11); assert.deepEqual(pair.source, source());
    assert.deepEqual(pair.fixtures.map(f => f.condition), ["quiet", "noise10db"]); assert.notDeepEqual(pair.fixtures[0]!.pcm, pair.fixtures[1]!.pcm);
    return pair.fixtures.map((f, j) => {
      assert.deepEqual(f.pcm, second[i]!.fixtures[j]!.pcm); assert.equal(f.pcm.length % 640, 0);
      const wav = pcm16Wav(f.pcm); assert.equal(wav.toString("ascii", 0, 4), "RIFF"); assert.equal(wav.readUInt32LE(4), wav.length - 8);
      assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(34), 16); assert.equal(wav.readUInt32LE(40), f.pcm.length); assert.deepEqual(wav.subarray(44), f.pcm);
      return { id: f.id, category: f.category, file: f.file, sha256: sha(f.pcm), expectedText: f.expectedText, criticalTerms: [...f.criticalTerms] };
    });
  });
  const parsed = parseTranscriptionEvaluationCorpus(bookingCorpus(cases)); assert.equal(parsed.cases.length, 16); assert.equal(new Set(parsed.cases.map(c => c.id)).size, 16);
  assert.equal(new Set(parsed.cases.map(c => c.expectedText)).size, 4); assert.ok(parsed.cases.some(c => c.criticalTerms.includes("not")));
});
for (const fault of ["empty", "silence", "odd", "oversize", "abort"] as const) test(`synthetic booking generation rejects ${fault} before exporting any corpus pair`, async () => {
  const lifetime = new AbortController(); let calls = 0;
  const factory = (): SpeechSynthesisPort => ({ async *stream() { calls++;
    if (fault === "empty") return;
    if (fault === "abort") { lifetime.abort(); yield source(); }
    else yield fault === "silence" ? Buffer.alloc(1280) : fault === "odd" ? Buffer.alloc(641) : Buffer.alloc(640_032);
  } });
  const iterator = buildBookingSpeechPairs(factory, lifetime.signal); await assert.rejects(iterator.next(), /invalid generated|aborted/); assert.equal(calls, 1);
});
test("synthetic booking generation does not request provider speech after an already aborted signal", async () => {
  const lifetime = new AbortController(); lifetime.abort(); let calls = 0;
  await assert.rejects(buildBookingSpeechPairs(() => { calls++; throw new Error("unexpected synthesis"); }, lifetime.signal).next(), /aborted/); assert.equal(calls, 0);
});
