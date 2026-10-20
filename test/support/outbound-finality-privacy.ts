import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { decodeTwilioOutboundReport } from "../../src/cliniko/twilio-outbound-report.ts";
import type { twilioOutboundFinalityFixture } from "./twilio-outbound-finality.ts";
import { value } from "./outbound-records.ts";

export async function assertOutboundFinalityPrivacy(db: Parameters<typeof scanPatientDataCanaries>[0], f: Awaited<ReturnType<typeof twilioOutboundFinalityFixture>>, databaseUrl: string) {
  assert.ok(f.admitted, "the actual admitted session remains available for full privacy witnesses");
  const original = f.original();
  const canaries = [f.reports.apiKey, f.request.patientId, original.number, f.callSid, original.attemptDigest, f.key.toString("hex"), f.carrier.contextKey.toString("hex"), f.carrier.authToken,
    f.form.get("Url")!, f.form.get("StatusCallback")!, f.form.toString(), f.admitted.receipt.callId, f.admitted.sessionId,
    ...f.reportPosts.flatMap(p => [String(p.notes), value(decodeTwilioOutboundReport(p.notes)).authentication]), ...f.dncPosts.map(p => String(p.notes)),
    ...f.outcomePosts.map(p => String(p.notes)), ...f.contactControls.rows.map(row => String(row.notes)), "Please stop calling me."];
  const chunks = canaries.flatMap((text, i) => Array.from({ length: Math.ceil(text.length / 256) }, (_, part) => {
    const v = text.slice(part * 256, (part + 1) * 256); return { label: `finality_${i}_${part}`, value: v.length < 4 ? text.slice(-4) : v }; }));
  for (let i = 0; i < chunks.length; i += 12) assert.deepEqual(await scanPatientDataCanaries(db, chunks.slice(i, i + 12)), { ok: true, value: [] });
  const dump = execFileSync("pg_dump", [databaseUrl, "--no-owner", "--no-privileges"], { timeout: 10000, maxBuffer: 8000000 }).toString();
  const copy = (v: string) => v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
  for (const text of canaries) { const json = JSON.stringify(text).slice(1, -1); for (const v of [text, copy(text), json, copy(json)]) assert.equal(dump.includes(v), false); }
}
