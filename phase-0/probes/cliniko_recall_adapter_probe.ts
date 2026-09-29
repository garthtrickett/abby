import { readFileSync } from "node:fs";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";

// Invoked inside the synthetic Python lifecycle probe. Only result kinds and
// booleans reach stdout; patient IDs, recall IDs, marker, and key stay transient.
try {
  const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
  const scope = { tenantId: "synthetic-probe", clinicId: "cliniko-demo" };
  const created = ClinikoRecallReader.create({ scope, apiKey: String(input.apiKey),
    contactEmail: String(input.contactEmail) });
  if (!created.ok) {
    process.stdout.write(JSON.stringify({ ok: false, kind: created.error.kind }));
    process.exitCode = 1;
  } else {
    const result = await created.value.findByMarker(scope, String(input.patientId), String(input.marker), input.archived === true);
    const exact = result.ok && result.value.kind === "one" &&
      result.value.recallRef === `cliniko:recall:${String(input.recallId)}` &&
      result.value.archived === (input.archived === true) &&
      result.value.recalled === (input.recalled === true);
    process.stdout.write(JSON.stringify({ ok: exact,
      kind: result.ok ? result.value.kind : result.error.kind,
      archived: result.ok && result.value.kind === "one" ? result.value.archived : null,
      recalled: result.ok && result.value.kind === "one" ? result.value.recalled : null }));
    if (!exact) process.exitCode = 1;
  }
} catch {
  process.stdout.write(JSON.stringify({ ok: false, kind: "probeFailure" }));
  process.exitCode = 1;
}
