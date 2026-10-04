import { statSync } from "node:fs";
import { getuid, loadEnvFile } from "node:process";
import { ClinikoReviewRehearsal } from "../phase-0/probes/cliniko_review_rehearsal.ts";

try {
  const [mode, secretFile] = process.argv.slice(2);
  if ((mode !== "prepare" && mode !== "status" && mode !== "cleanup") || (secretFile !== undefined && !secretFile.startsWith("--secret-file=")) ||
      process.argv.length > 4 || process.env.ABBY_LIVE_CLINIKO_EVAL !== "1") throw new Error("invalid rehearsal configuration");
  if (secretFile) {
    const path = secretFile.slice("--secret-file=".length), metadata = statSync(path);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || (typeof getuid !== "function" || metadata.uid !== getuid())) throw new Error("unsafe secret file");
    loadEnvFile(path);
  }
  const apiKey = process.env.ABBY_CLINIKO_API_KEY, contactEmail = process.env.ABBY_CLINIKO_CONTACT_EMAIL;
  if (!apiKey || !contactEmail) throw new Error("missing demo credentials");
  const result = await new ClinikoReviewRehearsal({ apiKey, contactEmail }).run(mode);
  if (!result.ok) {
    process.stdout.write(JSON.stringify({ ok: false, kind: result.error.kind })+"\n"); process.exitCode = 1;
  } else process.stdout.write(JSON.stringify({ ok: true, ...result.value })+"\n");
} catch { process.stderr.write("Cliniko review rehearsal unavailable\n"); process.exitCode = 1; }
