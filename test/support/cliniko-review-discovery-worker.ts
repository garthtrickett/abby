import { ClinikoRecallWriter } from "../../src/cliniko/recall-write.ts";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { encodeClinikoReview } from "../../src/cliniko/review-request.ts";
import type { ClinikoReviewRequest } from "../../src/cliniko/review-request.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import type { ClinikoClinicScope } from "../../src/cliniko/patients.ts";

const mode = process.argv[2];
const url = process.env.DATABASE_URL;
if ((mode !== "attempt" && mode !== "discover") || !url) throw new Error("invalid synthetic review worker configuration");
let inputText = "";
for await (const chunk of process.stdin) {
  inputText += String(chunk);
  if (inputText.length > 5_000) throw new Error("synthetic review input too large");
}
const input = JSON.parse(inputText) as { scope: ClinikoClinicScope; proxy: string; recallTypeId?: string;
  marker?: string; request?: ClinikoReviewRequest };
const allowed = mode === "attempt" ? ["scope", "proxy", "marker", "request"] : ["scope", "proxy", "recallTypeId"];
if (Object.keys(input).sort().join(",") !== allowed.sort().join(",")) throw new Error("unexpected synthetic recovery context");
const proxy = new URL(input.proxy);
if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1") throw new Error("invalid synthetic provider proxy");
const apiKey = "synthetic-review-key-au5";
const db = connectPostgres(url);
try {
  const fetchPort: typeof fetch = (original, init) => {
    const target = new URL(String(original));
    if (target.origin !== "https://api.au5.cliniko.com") throw new Error("unexpected synthetic provider origin");
    return fetch(`${proxy.origin}${target.pathname}${target.search}`, init);
  };
  const config = { scope: input.scope, apiKey, contactEmail: "test@example.com",
    rateBudget: new PostgresClinikoRequestBudget(db, { apiKey }) };
  if (mode === "attempt") {
    const encoded = encodeClinikoReview(input.marker!, input.request!);
    const writer = ClinikoRecallWriter.create(config, fetchPort);
    if (!encoded.ok || !writer.ok) throw new Error("invalid synthetic review request");
    const result = await writer.value.openOnce({ scope: input.scope, patientId: input.request!.patientId,
      marker: input.marker!, recallTypeId: "7", recallAt: "2026-10-04",
      summary: encoded.value.split("\n").slice(1).join("\n") });
    if (!result.ok) throw new Error("synthetic queue send failed");
    process.stdout.write(result.value.kind+"\n");
  } else {
    const reader = ClinikoRecallReader.create(config, fetchPort);
    if (!reader.ok) throw new Error("synthetic review reader unavailable");
    const result = await reader.value.discoverPendingReviews(input.scope, input.recallTypeId!);
    if (!result.ok) throw new Error("synthetic review discovery failed");
    const counts = { pending: result.value.pending.length, invalid: 0, ambiguous: 0, book: 0, cancel: 0, reschedule: 0 };
    let patientUpdates = 0, confirmationResends = 0;
    for (const item of result.value.pending) {
      if (item.kind === "invalidEnvelope") counts.invalid += 1;
      else if (item.kind === "ambiguousMarker") counts.ambiguous += 1;
      else if (item.envelope.request.operation.kind === "patientUpdate") patientUpdates++;
      else if (item.envelope.request.operation.kind === "confirmationResend") confirmationResends++;
      else counts[item.envelope.request.operation.kind] += 1;
    }
    // The test process reports aggregates only; no patient/request/marker escapes via stdout.
    process.stdout.write(JSON.stringify({ ...counts, ...(patientUpdates ? { patientUpdate: patientUpdates } : {}),
      ...(confirmationResends ? { confirmationResend: confirmationResends } : {}) })+"\n");
  }
} finally { await db.destroy(); }
