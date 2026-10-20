import { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { PostgresClinikoContactRevision } from "../../src/storage/postgres-cliniko-contact-revision.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import type { LocationScope } from "../../src/core/model.ts";
import { patientCorrectionCallFlowFixture } from "./patient-correction-call-flow.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

let raw = "";
for await (const chunk of process.stdin) { raw += String(chunk); if (raw.length > 3000) throw new Error("synthetic correction input too large"); }
const input = JSON.parse(raw) as { scope: LocationScope; proxy: string; phase: string };
const proxy = new URL(input.proxy);
if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || !process.env.DATABASE_URL?.includes("/abby_correction_crash_") ||
    proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1" || !["beforeFence", "duringSend", "afterSend", "afterSync"].includes(input.phase)) throw new Error("invalid synthetic correction process");
const db = connectPostgres(process.env.DATABASE_URL), f = await patientCorrectionCallFlowFixture({ scope: input.scope });
f.flow.dispose();
let flow: ClinikoCallFlow | undefined;
try {
  const c = f.flowConfig, contacts = new PostgresClinikoContactRevision(db, input.scope.tenantId,
    [clinikoCredentialFingerprint(c.cliniko.apiKey), clinikoCredentialFingerprint("synthetic-secondary-au5")]);
  flow = resultValue(ClinikoCallFlow.create({ ...c, cliniko: { ...c.cliniko, contactRevision: contacts,
    rateBudget: new PostgresClinikoRequestBudget(db, { apiKey: c.cliniko.apiKey }) }, correction: { ...c.correction!, contactRevision: contacts },
    fetchPort: (url, init) => {
      const target = new URL(String(url)); if (target.origin !== "https://api.au5.cliniko.com") throw new Error("unexpected synthetic correction origin");
      return fetch(`${proxy.origin}${target.pathname}${target.search}`, init);
    } }));
  const now = c.clock!();
  const play = async () => {
    const state = await f.state(); if (!state.pendingPresentationId) return;
    resultValue(await f.runtime.startPresentation(f.callId, state.pendingPresentationId, f.sessionId, now));
    resultValue(await f.runtime.resolvePresentation(f.callId, state.pendingPresentationId, "played", f.sessionId, now));
  };
  await play(); resultValue(await flow.choose("patientUpdate")); flow.beginVerification(); await flow.submitCode("");
  if (!(await flow.submitCode(f.mail.at(-1)!.code)).verified) throw new Error("synthetic correction verification unavailable");
  const terms = resultValue(await flow.patientCorrection!.begin());
  if (!await flow.patientCorrection!.acknowledge(terms.consentRef, true)) throw new Error("synthetic correction consent unavailable");
  const collected = resultValue(await flow.collectPatientCorrection({ post_code: "3999" }));
  const reception = new TextReception(f.ledger, f.policies, flow), gateway = new CommandGateway({ actorRef: "synthetic-agent", role: "agent", scope: f.scope }, f.policies, reception);
  const turn = (text: string) => ({ callId: f.callId, sessionId: f.sessionId, turnId: crypto.randomUUID(), text, quality: "clear" as const, at: now });
  resultValue(await gateway.submit({ kind: "patients.correction.propose.v1", correctionRef: collected.correctionRef, turn: turn("Prepare the correction"), now }));
  await play();
  const action = Object.values((await f.state()).actions).find(a => a.kind === "patientUpdate")!;
  resultValue(await reception.affirm(f.scope, turn("Yes"), action.key, action.digest, now));
  await new EffectWorker(f.runtime, flow, undefined, undefined, { clock: c.clock! }).process(f.callId, `${action.key}:write`, now);
  if (input.phase === "afterSync") await fetch(`${proxy.origin}/checkpoint`, { method: "POST" });
  process.stdout.write("settled\n");
} finally { flow?.dispose(); await f.close(); await db.destroy(); }
