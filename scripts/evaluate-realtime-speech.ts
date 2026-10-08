import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import WebSocket from "ws";
import { OpenAIRealtimeSpeechSynthesis } from "../src/voice/openai-realtime-speech-synthesis.ts";
import { StreamedPlaybackPort } from "../src/voice/streamed-playback-port.ts";
import { parseSpeechLoopCorpus } from "../src/voice/speech-loop-evaluation.ts";
import { assessSyntheticSpeechLatency } from "../src/voice/speech-latency-gate.ts";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const sourcePaths = ["src/voice/openai-realtime-speech-synthesis.ts", "src/voice/streamed-playback-port.ts",
  "src/voice/speech-loop-evaluation.ts", "src/voice/speech-latency-gate.ts", "scripts/evaluate-realtime-speech.ts"];
type Sample = { caseId: string; repeat: number; outcome: "queued" | "notSent" | "uncertain";
  chunks: number; firstChunkMs: number | null; totalMs: number; inputSha256: string;
  normalizedAudioBytes: number; normalizedAudioSha256: string; normalizedAudioPath: string;
  rawAudioBytes: number; rawAudioSha256: string; rawAudioPath: string; requests: unknown[];
  sessionModel: unknown; sessionVoice: unknown; sessionOutputFormat: unknown;
  firstRawAudioMs: number | null; responseStatus: unknown; responseTranscript: unknown; events: unknown[] };

function argumentsFrom(argv: readonly string[]): { out: string; repeats: number; concurrency: number } {
  const flags = new Map<string, string>();
  if (argv.length % 2) throw new Error("invalid arguments");
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!, value = argv[i + 1]!;
    if (!["--out", "--repeats", "--concurrency"].includes(key) || flags.has(key) || !value) {
      throw new Error("invalid arguments");
    }
    flags.set(key, value);
  }
  const out = flags.get("--out"), repeats = Number(flags.get("--repeats") ?? 20);
  const concurrency = Number(flags.get("--concurrency") ?? 2);
  if (!out?.trim() || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20 ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("invalid run limits");
  return { out, repeats, concurrency };
}

async function main(): Promise<void> {
  const args = argumentsFrom(process.argv.slice(2)), apiKey = process.env.ABBY_OPENAI_API_KEY;
  if (!apiKey) throw new Error("missing provider configuration");
  const corpusBytes = await readFile(resolve("eval/speech-loop-v1.json"));
  const corpus = parseSpeechLoopCorpus(JSON.parse(corpusBytes.toString("utf8")));
  const sourceFiles = await Promise.all(sourcePaths.map(async path => ({ path,
    sha256: digest(await readFile(resolve(path))) })));
  const output = resolve(args.out);
  await mkdir(dirname(output), { recursive: true });
  const reservation = await open(output, "wx", 0o600);
  await reservation.close();
  const audioDirectory = `${output}.audio`;
  await mkdir(audioDirectory, { mode: 0o700 });
  const results: Sample[] = [];
  let writes = Promise.resolve();
  const report = { schemaVersion: 1, kind: "realtime-speech-evaluation", state: "running",
    startedAt: new Date().toISOString(), configuration: { model: "gpt-realtime-2.1-mini", voice: "coral",
      validation: "completeProviderTranscriptBeforeAudio", corpusVersion: corpus.version,
      corpusSha256: digest(corpusBytes), sourceFiles, repeats: args.repeats, concurrency: args.concurrency,
      firstChunkDeadlineMs: 5_000, laterStepMs: 2_000, maxUtteranceMs: 20_000, nodeVersion: process.version },
    results, humanReviewStatus: "pending", liveCallStatus: "notRun", releaseGate: "unverified" };
  const save = () => {
    const bytes = `${JSON.stringify(report, null, 2)}\n`;
    writes = writes.then(() => writeFile(output, bytes, { mode: 0o600 }));
    return writes;
  };
  await save();
  const jobs = corpus.cases.flatMap(item => Array.from({ length: args.repeats }, (_, index) => ({ item, repeat: index + 1 })));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(args.concurrency, jobs.length) }, async () => {
    for (;;) {
      const index = next++, job = jobs[index];
      if (!job) return;
      const started = performance.now(), audio: Buffer[] = [], rawAudio: Buffer[] = [];
      const result: Sample = { caseId: job.item.id, repeat: job.repeat, outcome: "notSent", chunks: 0,
        firstChunkMs: null, totalMs: 0, inputSha256: digest(Buffer.from(job.item.text)), normalizedAudioBytes: 0,
        normalizedAudioSha256: digest(Buffer.alloc(0)), normalizedAudioPath: `${audioDirectory}/${index}.pcm`,
        rawAudioBytes: 0, rawAudioSha256: digest(Buffer.alloc(0)), rawAudioPath: `${audioDirectory}/${index}.raw.pcm`,
        requests: [], sessionModel: null,
        sessionVoice: null, sessionOutputFormat: null, firstRawAudioMs: null,
        responseStatus: null, responseTranscript: null, events: [] };
      try {
        const synthesis = new OpenAIRealtimeSpeechSynthesis({ apiKey, socketFactory(url, headers) {
          const socket = new WebSocket(url, { headers });
          // Observe this bounded synthetic candidate's exact request body and provider acknowledgments.
          const send = socket.send.bind(socket);
          socket.send = ((data: string) => {
            result.requests.push(JSON.parse(data)); send(data);
          }) as typeof socket.send;
          socket.on("message", data => {
            try {
              if (!(data instanceof Uint8Array) || data.byteLength > 256_000) return;
              const event = JSON.parse(data.toString());
              if (result.events.length < 5_000) result.events.push({ type: event.type,
                responseId: event.response_id ?? event.response?.id ?? null, itemId: event.item_id ?? null,
                outputIndex: event.output_index ?? null, contentIndex: event.content_index ?? null,
                item: event.item ? { id: event.item.id, type: event.item.type, role: event.item.role,
                  status: event.item.status } : null,
                partType: event.part?.type ?? null,
                response: event.type === "response.created" ? event.response : null,
                deltaChars: typeof event.delta === "string" ? event.delta.length : null,
              });
              if (event.type === "session.updated") {
                result.sessionModel = event.session?.model ?? null;
                result.sessionVoice = event.session?.audio?.output?.voice ?? null;
                result.sessionOutputFormat = event.session?.audio?.output?.format ?? null;
              } else if (event.type === "response.output_audio.delta" && typeof event.delta === "string") {
                if (result.firstRawAudioMs === null) result.firstRawAudioMs = Math.round(performance.now() - started);
                const bytes = Buffer.from(event.delta, "base64");
                if (result.rawAudioBytes + bytes.length <= 960_000) {
                  rawAudio.push(bytes); result.rawAudioBytes += bytes.length;
                }
              } else if (event.type === "response.done") {
                result.responseStatus = event.response?.status ?? null;
                result.responseTranscript = event.response?.output?.[0]?.content?.[0]?.transcript ?? null;
              }
            } catch { /* The adapter owns validation and rejects malformed events. */ }
          });
          return socket;
        } });
        const playback = new StreamedPlaybackPort(synthesis, {
          async queueChunk(_id, sequence, bytes) {
            if (sequence !== result.chunks) throw new Error("invalid sequence");
            if (result.firstChunkMs === null) result.firstChunkMs = Math.round(performance.now() - started);
            result.chunks += 1; result.normalizedAudioBytes += bytes.length; audio.push(Buffer.from(bytes));
            return "queued";
          },
          async finishQueue() { return "queued"; }, async clear() { return true; },
        }, { firstChunkDeadlineMs: 5_000 });
        result.outcome = await playback.enqueue(`realtime-speech-eval-${index}`, job.item.text,
          () => performance.now() < started + 20_000);
      } catch { result.outcome = result.chunks ? "uncertain" : "notSent"; }
      result.totalMs = Math.round(performance.now() - started);
      const normalized = Buffer.concat(audio), raw = Buffer.concat(rawAudio);
      result.normalizedAudioSha256 = digest(normalized);
      result.rawAudioSha256 = digest(raw);
      await writeFile(result.normalizedAudioPath, normalized, { flag: "wx", mode: 0o600 });
      await writeFile(result.rawAudioPath, raw, { flag: "wx", mode: 0o600 });
      results.push(result); await save();
      process.stdout.write(`${JSON.stringify({ caseId: result.caseId, repeat: result.repeat,
        outcome: result.outcome, firstChunkMs: result.firstChunkMs, totalMs: result.totalMs })}\n`);
    }
  }));
  results.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.repeat - b.repeat);
  for (const source of sourceFiles) {
    if (digest(await readFile(resolve(source.path))) !== source.sha256) throw new Error("evaluation source changed");
  }
  if (digest(await readFile(resolve("eval/speech-loop-v1.json"))) !== digest(corpusBytes)) throw new Error("corpus changed");
  const candidateGate = assessSyntheticSpeechLatency(results, corpus.cases.map(item => item.id));
  report.state = "complete";
  await save();
  // Add the latency assessment only after every worker and incremental report write settled.
  await writeFile(output, `${JSON.stringify({ ...report, completedAt: new Date().toISOString(), candidateGate }, null, 2)}\n`,
    { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ candidateGate, output, releaseGate: "unverified" })}\n`);
  if (candidateGate.status !== "pass") process.exitCode = 1;
}
main().catch(() => {
  process.stderr.write("Realtime speech evaluation failed; check run limits, configuration and owner-only evidence.\n");
  process.exitCode = 1;
});
