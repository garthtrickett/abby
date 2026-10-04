import { statSync } from "node:fs";
import { getuid, loadEnvFile } from "node:process";
import { ClinikoPrepatientMemoProbe } from "../phase-0/probes/cliniko_prepatient_memo.ts";

try {
  const [mode, secretFile] = process.argv.slice(2);
  if (!["omit", "null", "status", "cleanup"].includes(mode ?? "") || process.argv.length > 4 ||
      (secretFile !== undefined && !secretFile.startsWith("--secret-file=")) || process.env.ABBY_LIVE_CLINIKO_EVAL !== "1") {
    throw new Error("invalid probe configuration");
  }
  if (secretFile) {
    const path = secretFile.slice("--secret-file=".length), metadata = statSync(path);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || typeof getuid !== "function" || metadata.uid !== getuid()) {
      throw new Error("unsafe secret file");
    }
    loadEnvFile(path);
  }
  const apiKey = process.env.ABBY_CLINIKO_API_KEY, contactEmail = process.env.ABBY_CLINIKO_CONTACT_EMAIL;
  if (!apiKey || !contactEmail) throw new Error("missing demo credentials");
  const result = await new ClinikoPrepatientMemoProbe({ apiKey, contactEmail }).run(mode as "omit" | "null" | "status" | "cleanup");
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.ok) process.exitCode = 1;
} catch { process.stderr.write("Cliniko pre-patient memo probe unavailable\n"); process.exitCode = 1; }
