import { connectPostgres } from "../../src/storage/connect.ts";
import { ClinikoSamConfirmationResendHost } from "../../src/standalone/cliniko-sam-confirmation-resend-host.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import type { SmtpMailConfig } from "../../src/standalone/smtp-text-mail-transport.ts";
import { confirmationResendFixture } from "./confirmation-resend.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

let raw = "";
for await (const part of process.stdin) { raw += String(part); if (raw.length > 30_000) throw new Error("synthetic resend input too large"); }
const input = JSON.parse(raw) as { proxy: string; phase: string; folder: string; smtp: SmtpMailConfig };
const proxy = new URL(input.proxy);
if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || !process.env.DATABASE_URL?.includes("/abby_resend_crash_") ||
    proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1" || !input.folder.startsWith("/tmp/abby-resend-crash-") ||
    input.smtp.host !== "127.0.0.1" || input.smtp.username !== "synthetic-smtp-user" || input.smtp.password !== "synthetic-smtp-password" ||
    !["beforeClaim", "afterClaim", "duringSend", "afterAcceptance", "afterFinish"].includes(input.phase)) throw new Error("isolated resend process required");
const db = connectPostgres(process.env.DATABASE_URL), f = await confirmationResendFixture(db, input.smtp, "appointments.resend", true, "synthetic-session-au5", input.folder);
let host: ClinikoSamConfirmationResendHost | undefined;
try {
  const checkpoint = () => fetch(`${proxy.origin}/checkpoint`, { method: "POST" });
  const claim = f.journal.claim.bind(f.journal), finish = f.journal.finish.bind(f.journal);
  f.journal.claim = async ref => {
    if (input.phase === "beforeClaim") await checkpoint();
    const result = await claim(ref);
    if (input.phase === "afterClaim") await checkpoint();
    return result;
  };
  f.journal.finish = async (ref, status) => {
    if (input.phase === "afterAcceptance" && status.kind === "accepted") await checkpoint();
    const result = await finish(ref, status);
    if (input.phase === "afterFinish" && status.kind === "accepted") await checkpoint();
    return result;
  };
  const provider: typeof fetch = (value, init) => {
    const url = new URL(String(value));
    return init?.method === "POST" && url.pathname === "/v1/recalls"
      ? fetch(`${proxy.origin}${url.pathname}`, init) : f.config.fetchPort(value, init);
  };
  process.send?.({ kind: "fixture", scope: f.scope });
  await f.verify(); host = resultValue(await ClinikoSamConfirmationResendHost.create({ ...f.config, fetchPort: provider }));
  const prepared = resultValue(await host.prepare("81")), now = f.sessionConfig.clock();
  const turn = (text: string) => ({ callId: f.callId, sessionId: f.sessionId, turnId: crypto.randomUUID(), text, quality: "clear" as const, at: now });
  const reception = new TextReception(f.ledger, f.policies, host, undefined, undefined, undefined, undefined, f.sessionConfig.clock);
  resultValue(await reception.proposeConfirmationResend(f.scope, turn("Send my appointment email"), prepared.requestRef, now));
  const action = Object.values((await f.state()).actions).find(a => a.kind === "confirmationResend")!;
  resultValue(await f.runtime.startPresentation(f.callId, action.presentationId, f.sessionId, now));
  resultValue(await f.runtime.resolvePresentation(f.callId, action.presentationId, "played", f.sessionId, now));
  resultValue(await reception.affirm(f.scope, turn("Yes"), action.key, action.digest, now));
  await new EffectWorker(f.runtime, host).process(f.callId, `${action.key}:write`, now);
  process.stdout.write("settled\n");
} finally { host?.dispose(); await f.close(); await db.destroy(); }
