import { connectPostgres } from "../src/storage/connect.ts";
import { migrate } from "../src/storage/migrate.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const db = connectPostgres(connectionString);
try {
  await migrate(db, process.argv[2] === "down" ? "down" : "up");
} finally {
  await db.destroy();
}
