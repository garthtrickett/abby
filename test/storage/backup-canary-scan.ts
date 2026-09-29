import { spawn } from "node:child_process";
import type { PatientDataCanary } from "../../src/storage/patient-data-canary-scan.ts";

/** Scans a disposable PostgreSQL data dump in memory; returns labels, never dumped values. */
export async function scanDisposableBackupCanaries(connectionString: string,
                                                    canaries: readonly PatientDataCanary[]): Promise<readonly string[]> {
  if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1") throw new Error("isolated PostgreSQL probe required");
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1) ||
      canaries.length < 1 || canaries.length > 12 || canaries.some(canary =>
        !/^[a-z][a-z0-9_]{0,63}$/.test(canary.label) || canary.value.length < 4 || canary.value.length > 256) ||
      new Set(canaries.map(canary => canary.label)).size !== canaries.length) throw new Error("invalid backup probe input");
  // The PostgreSQL 17 image is already present in the disposable local and CI probes.
  const child = spawn("docker", ["run", "--rm", "--pull=never", "--network=host",
    "--env", "PGHOST", "--env", "PGPORT", "--env", "PGUSER", "--env", "PGPASSWORD",
    "postgres:17-alpine", "pg_dump", "--data-only", "--format=plain", "--no-owner", "--no-privileges",
    "--dbname", decodeURIComponent(url.pathname.slice(1))], {
    env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) },
    stdio: ["ignore", "pipe", "ignore"], signal: AbortSignal.timeout(30_000),
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error("backup probe failed")));
    child.once("close", code => code === 0 ? resolve() : reject(new Error("backup probe failed")));
  });
  void closed.catch(() => {});
  const needles = canaries.map(canary => ({ label: canary.label, bytes: Buffer.from(canary.value, "utf8") }));
  const overlap = Math.max(...needles.map(needle => needle.bytes.length)) - 1;
  const found = new Set<string>();
  let tail = Buffer.alloc(0);
  for await (const chunk of child.stdout) {
    const bytes = Buffer.concat([tail, Buffer.from(chunk)]);
    for (const needle of needles) if (bytes.includes(needle.bytes)) found.add(needle.label);
    tail = bytes.subarray(Math.max(0, bytes.length - overlap));
  }
  await closed;
  return [...found].sort();
}
