import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import type { twilioNotificationRecoveryFixture } from "./twilio-outbound-notification-recovery.ts";

type Fixture = Awaited<ReturnType<typeof twilioNotificationRecoveryFixture>>;
export async function assertNotificationPrivacy(db: Parameters<typeof scanPatientDataCanaries>[0], f: Fixture, databaseUrl: string) {
  const status = f.request(), original = f.runtime.authenticateStatus(status); assert.equal(original.ok, true);
  const canaries = [f.native.config.apiKey, f.original.attempt.patientId, f.payload.number, "CA" + "2".repeat(32), f.key.toString("hex"),
    f.config.contextKey.toString("hex"), f.config.authToken, status.body, status.signature!, ...(original.ok ? [original.value.call.context.attemptDigest] : []),
    ...[...f.native.rows.values()].map(r => String(r.notes))];
  const chunks = canaries.flatMap((text, i) => Array.from({ length: Math.ceil(text.length / 256) }, (_, p) => ({ label: `notification_${i}_${p}`,
    value: text.slice(p * 256, (p + 1) * 256).length < 4 ? text.slice(-4) : text.slice(p * 256, (p + 1) * 256) })));
  for (let i = 0; i < chunks.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, chunks.slice(i, i + 12)), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [databaseUrl, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  const copy = (v: string) => v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
  for (const raw of canaries) { const json = JSON.stringify(raw).slice(1, -1); for (const v of [raw, copy(raw), json, copy(json)]) assert.equal(dump.includes(v), false); }
}
