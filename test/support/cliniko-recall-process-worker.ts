import { ClinikoRecallWriter } from "../../src/cliniko/recall-write.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";

const mode = process.argv[2];
const url = process.env.DATABASE_URL;
const proxy = process.env.ABBY_TEST_RECALL_PROXY;
const tenantId = process.env.ABBY_TEST_RECALL_TENANT;
const patientId = process.env.ABBY_TEST_RECALL_PATIENT;
const marker = process.env.ABBY_TEST_RECALL_MARKER;
const summary = process.env.ABBY_TEST_RECALL_SUMMARY;
if ((mode !== "attempt" && mode !== "observe") || !url || !proxy || !tenantId || !patientId || !marker || !summary) {
  throw new Error("synthetic recall worker configuration missing");
}

const apiKey = "synthetic-recall-process-key-au5";
const db = connectPostgres(url);
try {
  const fetchPort: typeof fetch = async (input, init) => {
    const target = new URL(String(input));
    if (target.origin !== "https://api.au5.cliniko.com") throw new Error("unexpected provider origin");
    return fetch(`${proxy}${target.pathname}${target.search}`, init);
  };
  const scope = { tenantId, clinicId: "clinic" };
  const writer = ClinikoRecallWriter.create({ scope, apiKey, contactEmail: "test@example.com",
    rateBudget: new PostgresClinikoRequestBudget(db, { apiKey }) }, fetchPort);
  if (!writer.ok) throw new Error("synthetic recall writer unavailable");
  const request = { scope, patientId, marker, summary, recallTypeId: "7", recallAt: "2026-10-01" };
  if (mode === "attempt") {
    const result = await writer.value.openOnce(request);
    if (!result.ok || result.value.kind !== "uncertain") throw new Error("lost response was not uncertain");
    process.stdout.write("uncertain\n");
  } else {
    const result = await writer.value.observe(request);
    if (!result.ok || (result.value.kind !== "one" && result.value.kind !== "none")) {
      throw new Error("exact observation failed");
    }
    if (result.value.kind === "one" && (result.value.recalled || result.value.archived)) {
      throw new Error("unexpected recall status");
    }
    process.stdout.write(`${result.value.kind}\n`);
  }
} finally {
  await db.destroy();
}
