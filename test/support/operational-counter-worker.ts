import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresOperationalCounters } from "../../src/storage/postgres-operational-counters.ts";

const url = process.env.DATABASE_URL;
const tenantId = process.argv[2];
if (!url || !tenantId) throw new Error("counter worker configuration missing");

const db = connectPostgres(url);
try {
  const counters = new PostgresOperationalCounters(db);
  const scope = { tenantId, clinicId: "clinic", locationId: "main" };
  await Promise.all(Array.from({ length: 40 }, () => counters.record(scope, "admissionDenied")));
  await counters.drain();
} finally {
  await db.destroy();
}
