import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSpeechGateStatus } from "../../scripts/read-speech-gate-status.ts";

const transcriptionSources = ["src/voice/openai-realtime-transcription.ts",
  "src/voice/transcription-evaluation.ts", "src/voice/transcription-evaluation-gate.ts",
  "scripts/evaluate-transcription.ts"];
const speechSources = ["src/voice/openai-speech-synthesis.ts",
  "src/voice/first-chunk-fallback-speech.ts", "src/voice/streamed-playback-port.ts",
  "src/voice/speech-latency-gate.ts", "scripts/evaluate-first-chunk-fallback.ts"];
const canary = "PRIVATE SYNTHETIC TRANSCRIPT CANARY";

function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
async function sources(paths: readonly string[]): Promise<string> {
  return hash(Buffer.concat(await Promise.all(paths.map(path => readFile(path)))));
}
async function writePrivate(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
function cli(setPath: string) {
  return spawnSync(process.execPath, ["scripts/read-speech-gate-status.ts"], { encoding: "utf8",
    env: { ...process.env, ABBY_SPEECH_GATE_REPORT_SET: setPath } });
}

test("E2E-233 owner speech-gate status is aggregate-only and refuses stale or public reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "abby-speech-gate-"));
  const setPath = join(directory, "current.json");
  try {
    const transcriptionHash = await sources(transcriptionSources);
    const speechHash = await sources(speechSources);
    const reports: Record<string, string> = {};
    for (const name of ["telephony", "noise", "safety"] as const) {
      const corpusVersion = `transcription-${name}-v1`;
      const corpusBytes = await readFile(`eval/${corpusVersion}.json`);
      const corpus = JSON.parse(corpusBytes.toString("utf8")) as { cases: { id: string; category: string }[] };
      const path = join(directory, `${name}.json`);
      reports[name] = path;
      await writePrivate(path, { kind: "realtime-transcription-evaluation", releaseGate: "unverified",
        configuration: { corpusVersion, corpusSha256: hash(corpusBytes), adapterSha256: transcriptionHash,
          model: "gpt-live-transcribe" },
        results: name === "noise" ? [{ caseId: corpus.cases[0]!.id, category: corpus.cases[0]!.category,
          repeat: 1, verdict: "critical", actualText: canary, totalMs: 500, finalMs: 100,
          quality: "needsClarification" }] : [] });
    }
    const speechBytes = await readFile("eval/speech-loop-v1.json");
    reports.speech = join(directory, "speech.json");
    await writePrivate(reports.speech, { kind: "speech-first-chunk-fallback-evaluation", releaseGate: "unverified",
      configuration: { corpusVersion: "speech-loop-v1", corpusSha256: hash(speechBytes), sourceSha256: speechHash,
        primaryModel: "gpt-4o-mini-tts", fallbackModel: "tts-1", primaryFirstChunkMs: 1_500,
        voice: "coral", combinedFirstChunkMs: 5_000, laterStepMs: 2_000,
        maxUtteranceMs: 20_000, repeats: 20, concurrency: 4 }, results: [] });
    const recorded = spawnSync(process.execPath, ["scripts/assess-speech-evaluation.ts",
      "--telephony", reports.telephony!, "--noise", reports.noise!, "--safety", reports.safety!,
      "--speech", reports.speech, "--record-current", setPath], { encoding: "utf8" });
    assert.equal(recorded.status, 1);
    assert.equal(recorded.stderr, "");
    assert.equal((await stat(setPath)).mode & 0o777, 0o600);

    const status = await readSpeechGateStatus(setPath);
    assert.equal(status.syntheticCandidateGate, "fail");
    assert.equal(status.releaseGate, "unverified");
    assert.equal(status.representativeCallGate, "notRun");
    assert.equal(JSON.stringify(status).includes(canary), false);
    const failedGate = cli(setPath);
    assert.equal(failedGate.status, 2);
    assert.equal(failedGate.stderr, "");
    assert.equal(failedGate.stdout.includes(canary), false);
    assert.equal(failedGate.stdout.includes(directory), false);

    await chmod(setPath, 0o644);
    const publicSet = cli(setPath);
    assert.equal(publicSet.status, 1);
    assert.equal(publicSet.stdout, "");
    assert.equal(publicSet.stderr, "speech gate status unavailable\n");
    await chmod(setPath, 0o600);
    await chmod(reports.noise!, 0o644);
    const publicReport = cli(setPath);
    assert.equal(publicReport.status, 1);
    assert.equal(publicReport.stdout, "");
    assert.equal(publicReport.stderr, "speech gate status unavailable\n");
    await chmod(reports.noise!, 0o600);
    const stale = JSON.parse(await readFile(reports.speech, "utf8")) as {
      configuration: { sourceSha256: string } };
    stale.configuration.sourceSha256 = "0".repeat(64);
    await writePrivate(reports.speech, stale);
    const staleResult = cli(setPath);
    assert.equal(staleResult.status, 1);
    assert.equal(staleResult.stdout, "");
    assert.equal(staleResult.stderr, "speech gate status unavailable\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
