import { fileURLToPath } from "node:url";
import { validOperationalCounts } from "../src/voice/operational-counts.ts";
import type { OperationalCounts } from "../src/voice/operational-counts.ts";

/** Operator-only local read. The bearer token stays in the process environment, not command arguments. */
export async function readVoiceOperations(): Promise<OperationalCounts> {
  const port = process.env.ABBY_VOICE_PORT;
  const tokenHex = process.env.ABBY_VOICE_OPERATIONS_TOKEN_HEX;
  if (!port || !/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535 ||
      !tokenHex || !/^[a-f0-9]{64}$/i.test(tokenHex)) throw new Error("operational read unavailable");
  const response = await fetch(`http://127.0.0.1:${port}/internal/operations`, { headers: {
    authorization: `Bearer ${tokenHex}` }, signal: AbortSignal.timeout(5_000) });
  if (response.status !== 200) throw new Error("operational read unavailable");
  const counts: unknown = await response.json();
  if (!validOperationalCounts(counts)) throw new Error("operational read unavailable");
  return counts;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.stdout.write(`${JSON.stringify(await readVoiceOperations())}\n`); }
  catch { process.stderr.write("operational read unavailable\n"); process.exitCode = 1; }
}
