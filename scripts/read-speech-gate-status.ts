import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessSpeechReports } from "./assess-speech-evaluation.ts";
import type { SpeechProfile, SpeechReportPaths } from "./assess-speech-evaluation.ts";

const reportNames = ["telephony", "noise", "safety", "speech"] as const;
const defaultSet = resolve("eval/results/current-speech-gate.json");

async function ownerFile(path: string, maxBytes: number): Promise<void> {
  if (!isAbsolute(path)) throw new Error("invalid speech gate report set");
  const info = await lstat(path);
  if (!info.isFile() || info.size < 1 || info.size > maxBytes ||
      (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error("invalid speech gate report set");
  }
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export async function readSpeechGateStatus(setPath = process.env.ABBY_SPEECH_GATE_REPORT_SET ?? defaultSet) {
  await ownerFile(setPath, 4_096);
  const set: unknown = JSON.parse(await readFile(setPath, "utf8"));
  if (!exactKeys(set, ["schemaVersion", "speechProfile", "reports"]) || set.schemaVersion !== 1 ||
      (set.speechProfile !== "default" && set.speechProfile !== "tts-1-primary-v1") ||
      !exactKeys(set.reports, reportNames)) throw new Error("invalid speech gate report set");
  const reports = set.reports as Record<typeof reportNames[number], unknown>;
  for (const name of reportNames) {
    const path = reports[name];
    if (typeof path !== "string" || path.length > 4_096) throw new Error("invalid speech gate report set");
    await ownerFile(path, 2_000_000);
  }
  const summary = await assessSpeechReports({ ...reports as SpeechReportPaths,
    speechProfile: set.speechProfile as SpeechProfile });
  return { kind: "speechGateStatus" as const, ...summary };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  readSpeechGateStatus().then(summary => {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.syntheticCandidateGate !== "pass") process.exitCode = 2;
  }).catch(() => {
    process.stderr.write("speech gate status unavailable\n");
    process.exitCode = 1;
  });
}
