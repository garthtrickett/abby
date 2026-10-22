import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import type { twilioOutboundStatusVoiceFixture } from "./twilio-outbound-status-voice.ts";

export async function assertStatusPrivacy(db: Parameters<typeof scanPatientDataCanaries>[0],
  f: Awaited<ReturnType<typeof twilioOutboundStatusVoiceFixture>>, databaseUrl: string) {
  const original = f.original(), request = f.statusRequest();
  const canaries = [f.config.stop.requests.apiKey, f.request.patientId, original.number, f.callSid, original.attemptDigest,
    ...f.acceptedTranscripts, f.key.toString("hex"), f.notificationKey.toString("hex"), f.carrier.contextKey.toString("hex"), f.carrier.authToken,
    f.form.get("Url")!, f.form.get("StatusCallback")!, f.form.toString(), request.body, request.signature,
    f.admitted!.receipt.callId, f.admitted!.sessionId, ...f.contactControls.rows.map(row => String(row.notes)),
    ...f.reportPosts.map(p => String(p.notes)), ...f.dncPosts.map(p => String(p.notes)), ...f.notificationPosts.map(p => String(p.notes)),
    ...f.staffPosts.map(p => String(p.notes))];
  const chunks = canaries.flatMap((text, i) => Array.from({ length: Math.ceil(text.length / 256) }, (_, j) => ({ label: `status_${i}_${j}`,
    value: text.slice(j * 256, (j + 1) * 256).length < 4 ? text.slice(-4) : text.slice(j * 256, (j + 1) * 256) })));
  for (let i = 0; i < chunks.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, chunks.slice(i, i + 12)), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [databaseUrl, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  const copy = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
  for (const raw of canaries) { const json = JSON.stringify(raw).slice(1, -1); for (const value of [raw, copy(raw), json, copy(json)]) assert.equal(dump.includes(value), false); }
  return dump;
}
