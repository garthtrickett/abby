import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import WebSocket from "ws";
import { OpenAIRealtimeTranscription } from "../src/voice/openai-realtime-transcription.ts";
import { parseTranscriptionEvaluationCorpus, runTranscriptionEvaluation } from "../src/voice/transcription-evaluation.ts";
import { assessSyntheticTranscription } from "../src/voice/transcription-evaluation-gate.ts";
import { bookingSpeechPhrases, bookingSpeechVoices } from "./lib/booking-speech-fixtures.ts";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function args(argv: readonly string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!key || !["--out", "--repeats", "--concurrency"].includes(key) || !value || values.has(key)) throw new Error("invalid arguments"); values.set(key, value);
  }
  const repeats = Number(values.get("--repeats") ?? 3), concurrency = Number(values.get("--concurrency") ?? 2), out = values.get("--out");
  if (!out?.trim() || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("invalid run limits");
  return { repeats, concurrency, out: resolve(out) };
}
async function main() {
  const a = args(process.argv.slice(2)), apiKey = process.env.ABBY_OPENAI_API_KEY; if (!apiKey) throw new Error("missing configuration");
  // Only the reviewed bundled corpus is accepted. The CLI cannot choose a
  // recording, text prompt, arbitrary corpus file or recognition keyword.
  const bytes = await readFile(resolve("eval/transcription-booking-v1.json")), corpus = parseTranscriptionEvaluationCorpus(JSON.parse(bytes.toString("utf8")));
  if (corpus.version !== "transcription-booking-v1" || corpus.cases.length !== 16) throw new Error("invalid booking corpus");
  const cases = await Promise.all(corpus.cases.map(async (item, index) => {
    const phrase = bookingSpeechPhrases[Math.floor(index / 2) % 4]!, voice = bookingSpeechVoices[Math.floor(index / 8)]!, condition = index % 2 ? "noise10db" : "quiet";
    if (item.id !== `BK-${String(index + 1).padStart(3, "0")}` || item.expectedText !== phrase.text || JSON.stringify(item.criticalTerms) !== JSON.stringify(phrase.criticalTerms) ||
        item.file !== `booking-${phrase.id}-${voice}-${condition}-pcmu.pcm` || item.category !== `${phrase.id}-${voice}-${condition === "quiet" ? "quiet" : "noise"}`) throw new Error("unexpected booking fixture");
    const pcm = await readFile(resolve("eval/audio", item.file)); if (sha(pcm) !== item.sha256 || pcm.length < 640 || pcm.length > 640_000 || pcm.length % 640) throw new Error("booking fixture changed"); return { ...item, pcm };
  }));
  const paths = ["scripts/evaluate-booking-transcription.ts", "scripts/lib/booking-speech-fixtures.ts", "src/voice/openai-realtime-transcription.ts", "src/voice/transcription-evaluation.ts", "src/voice/transcription-evaluation-gate.ts"];
  const sourceFiles = await Promise.all(paths.map(async path => ({ path, sha256: sha(await readFile(resolve(path))) })));
  const jobs = cases.flatMap(item => Array.from({ length: a.repeats }, (_, i) => ({ caseId: item.id, repeat: i + 1 }))), probes: { caseId: string; repeat: number; request?: unknown; acknowledgment?: unknown; audioBytes: number; audioSha256?: string; commits: number }[] = [], hashes: ReturnType<typeof createHash>[] = [];
  const report = { schema: "abby.synthetic-booking-transcription.v1", state: "running", startedAt: new Date().toISOString(), patientFree: true, configuration: { model: "gpt-live-transcribe", corpusVersion: corpus.version, corpusSha256: sha(bytes), repeats: a.repeats, concurrency: a.concurrency, sourceFiles }, probes,
    releaseGate: "unverified", humanReview: "notRun", carrier: "notRun", originalSpeechGate: "unchangedAndSeparate" };
  await mkdir(dirname(a.out), { recursive: true }); const reservation = await open(a.out, "wx", 0o600); await reservation.close(); await writeFile(a.out, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const results = await runTranscriptionEvaluation(cases, sessionId => {
    const job = jobs[probes.length]; if (!job) throw new Error("unexpected provider session");
    const probe = { ...job, audioBytes: 0, commits: 0 } as typeof probes[number], hash = createHash("sha256"); probes.push(probe); hashes.push(hash);
    return new OpenAIRealtimeTranscription({ apiKey, sessionId, socketFactory(url, headers) {
      const socket = new WebSocket(url, { headers }), send = socket.send.bind(socket);
      socket.send = ((data: string) => { const event = JSON.parse(data);
        if (event.type === "session.update") probe.request = event;
        if (event.type === "input_audio_buffer.append") { const pcm = Buffer.from(event.audio, "base64"); hash.update(pcm); probe.audioBytes += pcm.length; }
        if (event.type === "input_audio_buffer.commit") probe.commits++;
        send(data);
      }) as WebSocket["send"];
      socket.on("message", data => { try { if (data instanceof Uint8Array && data.byteLength <= 64_000) { const e = JSON.parse(data.toString()); if (e.type === "session.updated") probe.acknowledgment = { type: e.session?.type, audioInput: e.session?.audio?.input }; } } catch { /* The real adapter owns protocol validation. */ } });
      return socket;
    } });
  }, a.repeats, a.concurrency);
  probes.forEach((probe, index) => { probe.audioSha256 = hashes[index]!.digest("hex"); });
  const counts = { match: 0, mismatch: 0, critical: 0, providerFailure: 0 }; for (const r of results) counts[r.verdict]++;
  const assessment = assessSyntheticTranscription(cases, results), groups = ["quiet", "noise"].map(condition => {
    const selected = cases.filter(c => c.category.endsWith(`-${condition}`)), ids = new Set(selected.map(c => c.id)); return { condition, assessment: assessSyntheticTranscription(selected, results.filter(r => ids.has(r.caseId))) };
  });
  const final = { ...report, state: "completed", finishedAt: new Date().toISOString(), counts, results, assessment, groups }; await writeFile(a.out, JSON.stringify(final, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ counts, assessment, groups, output: a.out, releaseGate: "unverified" })); if (assessment.status !== "pass") process.exitCode = 1;
}
main().catch(() => { console.error("Booking transcription evaluation could not complete; check its arguments and private partial report."); process.exitCode = 1; });
