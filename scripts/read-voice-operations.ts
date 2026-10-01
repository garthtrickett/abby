import { fileURLToPath } from "node:url";
import { validOperationalCounts, validOperationalDailyCounts } from "../src/voice/operational-counts.ts";
import type { OperationalCounts, OperationalDailyCounts } from "../src/voice/operational-counts.ts";

/** Operator-only local read. The bearer token stays in the process environment, not command arguments. */
async function read(path: string): Promise<unknown> {
  const port = process.env.ABBY_VOICE_PORT;
  const tokenHex = process.env.ABBY_VOICE_OPERATIONS_TOKEN_HEX;
  if (!port || !/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535 ||
      !tokenHex || !/^[a-f0-9]{64}$/i.test(tokenHex)) throw new Error("operational read unavailable");
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: {
    authorization: `Bearer ${tokenHex}` }, signal: AbortSignal.timeout(5_000) });
  if (response.status !== 200) throw new Error("operational read unavailable");
  return response.json();
}

export async function readVoiceOperations(): Promise<OperationalCounts> {
  const counts = await read("/internal/operations");
  if (!validOperationalCounts(counts)) throw new Error("operational read unavailable");
  return counts;
}

export async function readVoiceOperationsDaily(): Promise<OperationalDailyCounts> {
  const counts = await read("/internal/operations/daily");
  if (!validOperationalDailyCounts(counts)) throw new Error("operational read unavailable");
  return counts;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--daily")) throw new Error("invalid argument");
    process.stdout.write(`${JSON.stringify(process.argv[2] === "--daily"
      ? await readVoiceOperationsDaily() : await readVoiceOperations())}\n`);
  }
  catch { process.stderr.write("operational read unavailable\n"); process.exitCode = 1; }
}
