import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";

type ProbeInput = Readonly<{
  apiKey: string;
  contactEmail: string;
  email: string;
  dateOfBirth: string;
  wrongDateOfBirth: string;
  patientId: string;
  expectedKind: "one" | "ambiguous";
}>;

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
let input: ProbeInput;
try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProbeInput; }
catch { process.stdout.write(JSON.stringify({ ok: false, step: "input" })); process.exit(1); }

const scope = { tenantId: "synthetic-probe", clinicId: "cliniko-demo" };
const created = ClinikoPatientCandidateReader.create({ scope, apiKey: input.apiKey, contactEmail: input.contactEmail });
if (!created.ok) {
  process.stdout.write(JSON.stringify({ ok: false, step: "create", failure: created.error.kind }));
  process.exit(1);
}
const exact = await created.value.findByEmailAndBirthDate(scope, input.email, input.dateOfBirth);
const wrong = await created.value.findByEmailAndBirthDate(scope, input.email, input.wrongDateOfBirth);
const exactMatches = exact.ok && exact.value.kind === input.expectedKind &&
  (exact.value.kind === "ambiguous" ? !("candidateRef" in exact.value)
    : exact.value.kind === "one" && exact.value.candidateRef === `cliniko:patient:${input.patientId}`) &&
  !("verificationRef" in exact.value);
const ok = exactMatches && wrong.ok && wrong.value.kind === "none";
process.stdout.write(JSON.stringify({ ok, exactKind: exact.ok ? exact.value.kind : exact.error.kind,
  wrongBirthDateKind: wrong.ok ? wrong.value.kind : wrong.error.kind }));
if (!ok) process.exitCode = 1;
