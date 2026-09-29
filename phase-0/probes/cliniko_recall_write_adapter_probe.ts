import { readFileSync } from "node:fs";
import { ClinikoRecallWriter } from "../../src/cliniko/recall-write.ts";

type Input = {
  apiKey: string;
  contactEmail: string;
  patientId: string;
  recallTypeId: string;
  recallAt: string;
  marker: string;
};

try {
  const input = JSON.parse(readFileSync(0, "utf8")) as Input;
  const scope = { tenantId: "cliniko-recall-live-probe", clinicId: "demo" };
  const created = ClinikoRecallWriter.create({ scope, apiKey: input.apiKey,
    contactEmail: input.contactEmail });
  if (!created.ok) throw new Error(`writer_${created.error.kind}`);
  const sent = await created.value.openOnce({ scope, patientId: input.patientId,
    recallTypeId: input.recallTypeId, recallAt: input.recallAt, marker: input.marker,
    summary: "Synthetic demo follow-up; archive after probe." });
  if (!sent.ok) throw new Error(`write_${sent.error.kind}`);
  if (sent.value.kind === "uncertain") {
    process.stdout.write(JSON.stringify({ ok: true, kind: "uncertain" }));
  } else {
    process.stdout.write(JSON.stringify({ ok: true, kind: "accepted",
      recallId: sent.value.recallRef.slice("cliniko:recall:".length) }));
  }
} catch (cause) {
  const label = cause instanceof Error && /^[a-z]+_[A-Za-z]+$/.test(cause.message)
    ? cause.message : "writer_probe_failed";
  process.stdout.write(JSON.stringify({ ok: false, error: label }));
  process.exitCode = 1;
}
