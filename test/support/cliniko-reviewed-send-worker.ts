import { ClinikoRecallWriter } from "../../src/cliniko/recall-write.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { ClinikoReviewRequest } from "../../src/cliniko/review-request.ts";
import { ClinikoReviewedSend } from "../../src/standalone/cliniko-reviewed-send.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";

let inputText = "";
for await (const chunk of process.stdin) {
  inputText += String(chunk);
  if (inputText.length > 5_000) throw new Error("synthetic reviewed-send input too large");
}
const input = JSON.parse(inputText) as { request: ClinikoReviewRequest; proxy: string;
  checkpoint: "beforeMutation" | "duringMutation" | "afterMutation" };
if (Object.keys(input).sort().join(",") !== "checkpoint,proxy,request" || !process.env.DATABASE_URL ||
    !["beforeMutation", "duringMutation", "afterMutation"].includes(input.checkpoint)) {
  throw new Error("invalid synthetic reviewed-send configuration");
}
const proxy = new URL(input.proxy);
if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1") throw new Error("invalid synthetic proxy");
const apiKey = "synthetic-review-key-au5";
const db = connectPostgres(process.env.DATABASE_URL);
try {
  const fetchPort: typeof fetch = (original, init) => {
    const target = new URL(String(original));
    if (target.origin !== "https://api.au5.cliniko.com") throw new Error("unexpected synthetic origin");
    return fetch(`${proxy.origin}${target.pathname}${target.search}`, init);
  };
  const writer = ClinikoRecallWriter.create({ scope: input.request.scope, apiKey,
    contactEmail: "test@example.com", rateBudget: new PostgresClinikoRequestBudget(db, { apiKey }) }, fetchPort);
  if (!writer.ok) throw new Error("synthetic reviewed-send writer unavailable");
  const gate = new ClinikoReviewedSend({ scope: input.request.scope, writer: writer.value,
    businessId: input.request.businessId, credentialFingerprint: clinikoCredentialFingerprint(apiKey),
    policyVersion: input.request.policyVersion, timeZone: input.request.timeZone, recallTypeId: "7",
    clock: () => Date.parse(input.request.createdAt) });
  let guards = 0;
  const result = await gate.run(input.request, {
    authorize: async (_request, signal) => {
      if (++guards === 2 && input.checkpoint === "beforeMutation") {
        await fetch(`${proxy.origin}/checkpoint`, { method: "POST", signal });
      }
      return true;
    },
    send: async (request, signal) => {
      // Synthetic mutation port: tests the send order, not the operation's own provider contract.
      const response = await fetch(`${proxy.origin}/v1/individual_appointments/71`, {
        method: "PATCH", signal, body: JSON.stringify(request.operation), headers: { "Content-Type": "application/json" },
      });
      return { kind: response.ok ? "syntheticAccepted" : "syntheticUncertain" };
    },
  }, new AbortController().signal);
  if (!result.ok) throw new Error("synthetic reviewed-send gate failed");
  if (input.checkpoint === "afterMutation") await fetch(`${proxy.origin}/checkpoint`, { method: "POST" });
  process.stdout.write("settled\n");
} finally { await db.destroy(); }
