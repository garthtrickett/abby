import { clinicFAQFixture, publicDirections } from "../../test/support/clinic-faqs.ts";
import { urgentConversationFixture, urgentReply } from "../../test/support/urgent-conversation.ts";
import { bookingCatalogueFixture } from "../../test/support/cliniko-booking-catalogue.ts";
import type { Kysely } from "kysely";
import type Database from "../../src/storage/generated/Database.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import type { ClinikoWorkflow } from "../../src/standalone/cliniko-call-flow.ts";
import type { VoiceIntent } from "../../src/voice/voice-session.ts";
import { bookingCallFlowFixture, cancellationCallFlowFixture, reschedulingCallFlowFixture } from "../../test/support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../../test/support/cliniko-workflow-voice.ts";
import { verificationCanaries } from "../../test/support/caller-verification.ts";
import { clinikoStaffCallFlowFixture } from "../../test/support/cliniko-staff-call-flow.ts";
import { appointmentEnquiryFixture } from "../../test/support/cliniko-appointment-enquiry.ts";
import type { CallState } from "../../src/core/model.ts";
import type { Candidate, Plan } from "./plans.ts";

export type ModelConfig = Readonly<{ mode: "scripted" | "live"; model: string; apiKey: string }>;
type Call = Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>>;
type Decision = { kind: string; operation: ClinikoWorkflow | null; stage: "targets" | "offers" | null;
  from: string | null; to: string | null; choice: 1 | 2 | 3 | null };
const decision = (kind: string, change: Partial<Decision> = {}): Decision =>
  ({ kind, operation: null, stage: null, from: null, to: null, choice: null, ...change });
const setupDecisions: Record<string, Decision> = {
  "I only want to check my appointments.": decision("workflow", { operation: "appointments.read" }),
  "I need to book an appointment.": decision("workflow", { operation: "book" }),
  "I need to cancel an appointment.": decision("workflow", { operation: "cancel" }),
  "I need to move an appointment.": decision("workflow", { operation: "reschedule" }),
  "What times are available on October 8?": decision("menu", { from: "2026-10-08", to: "2026-10-08" }),
  "What times are available on October 9?": decision("menu", { from: "2026-10-09", to: "2026-10-09" }),
  "What times are available on October 8 and 9?": decision("menu", { from: "2026-10-08", to: "2026-10-09" }),
  "The first time, please.": decision("choice", { choice: 1 }),
  "Show me my appointments from October 4 through October 9.": decision("appointments", { from: "2026-10-04", to: "2026-10-09" }),
  "Cancel that appointment.": decision("cancel"),
  "Show my existing appointments from October 4 through October 9.": decision("menu", { stage: "targets", from: "2026-10-04", to: "2026-10-09" }),
  "My first existing appointment.": decision("choice", { stage: "targets", choice: 1 }),
  "Show move times on October 8.": decision("menu", { stage: "offers", from: "2026-10-08", to: "2026-10-08" }),
};

async function prepare(call: Call, plan: Plan, mail: { code: string }[], id: string): Promise<void> {
  if (plan.stage === "initial") return;
  if (plan.stage === "staff" || plan.stage === "staffUncertain") {
    await call.turn("Could I speak to a receptionist?"); await call.mark();
    await voiceUntil(() => mail.length === 1, "independent staff verification email"); await call.verify(mail[0]!.code);
    if (plan.stage === "staffUncertain") { await call.turn("Please send that request."); await call.mark(); }
    return;
  }
  const operation = plan.stage === "enquiry" ? "appointments.read" : plan.stage.startsWith("cancel") ? "cancel" : plan.stage.startsWith("move") ? "reschedule" : "book";
  const play = async (text: string) => { await call.turn(text); await call.mark(); };
  await play({ book: "I need to book an appointment.", cancel: "I need to cancel an appointment.", reschedule: "I need to move an appointment.", "appointments.read": "I only want to check my appointments." }[operation]);
  await voiceUntil(() => mail.length === 1, "synthetic verification email"); await call.verify(mail[0]!.code);
  if (plan.stage === "book" || plan.stage === "move" || plan.stage === "enquiry") return;
  if (operation === "cancel") {
    await play("Show me my appointments from October 4 through October 9.");
    if (plan.stage === "cancel") return;
    if (plan.stage === "cancelCommitted") { await play("Cancel that appointment."); await play("Yes"); }
    return;
  }
  if (operation === "reschedule") {
    await play("Show my existing appointments from October 4 through October 9.");
    await play("My first existing appointment."); await play("Show move times on October 8."); return;
  }
  await play(id === "CCP-006" ? "What times are available on October 8 and 9?" : "What times are available on October 8?");
  if (id === "CCP-007") await play("What times are available on October 9?");
  if (plan.stage === "menu") return;
  await play("The first time, please.");
  if (plan.stage === "committed" || plan.stage === "uncertain") await play("Yes");
}

type Check = Readonly<{ id: string; pass: boolean; detail: string }>;
function publicIntent(intent: VoiceIntent | null): Record<string, string | number> | null {
  if (!intent) return null;
  const result: Record<string, string | number> = { kind: intent.kind };
  for (const field of ["operation", "stage", "choice", "from", "to", "reason"] as const) {
    if (field in intent) { const value = (intent as unknown as Record<string, unknown>)[field];
      if (typeof value === "string" || typeof value === "number") result[field] = value; }
  }
  return result;
}
function conversationCheck(candidate: Candidate, plan: Plan, intents: (VoiceIntent | null)[], speech: string[], before: CallState, after: CallState): Check {
  const last = intents.at(-1), text = speech.join(" ");
  const statuses = Object.values(after.actions).map(action => action.status), latest = Object.values(after.actions).at(-1);
  let pass = false;
  switch (plan.expectation) {
    case "cancelProposal": pass = last?.kind === "cancel" && statuses.includes("awaitingConfirmation"); break;
    case "spokenChoice": pass = last?.kind === "bookingChoice" && last.choice === 2 && statuses.includes("awaitingConfirmation"); break;
    case "revisedProposal": pass = latest?.status === "awaitingConfirmation" && latest.mutation.request.kind === "book" &&
      latest.mutation.request.offer.startsAt === "2026-10-07T23:30:00.000Z" && Object.values(before.actions)
        .some(action => action.status === "awaitingConfirmation" && after.actions[action.key]?.status === "canceled"); break;
    case "revisedDate": pass = last?.kind === "bookingMenu" && last.from === "2026-10-07" && last.to === "2026-10-07" &&
      last.window?.startMinute === 0 && last.window.endMinute === 720 && last.window.startInclusive &&
      /before 12:00 pm.*Wednesday 7 October.*9:00 am/s.test(text) && !/4:30 pm/.test(text) && !statuses.includes("awaitingConfirmation"); break;
    case "outcome": pass = (last?.kind === "outcome" || last?.kind === "clarify" && last.reason === "changeAfterSend") &&
      /confirmed|can't confirm|contact the clinic/i.test(text); break;
    case "readOnly": pass = last?.kind === "appointmentEnquiry" && after.appointmentReads.at(-1)?.status === "shown" &&
      /checked upcoming appointments between.*I found an appointment on/s.test(text) && !Object.keys(after.actions).length; break;
    case "clarify": pass = /which|clarif|repeat|did you mean|please (say|tell)|do you want|would you like/i.test(text) && !statuses.includes("awaitingConfirmation"); break;
    case "human": pass = /reception|clinic|staff|person/i.test(text) && /contact the clinic|transfer.*unavailable|request.*saved|can't confirm.*request/i.test(text); break;
    case "urgent": pass = last?.kind === "handoff" && last.reason === "potentiallyUrgent" && speech.includes(urgentReply) &&
      !Object.keys(after.actions).length && !Object.keys(after.staffItems).length && !/I (?:have|am) transfer|staff (?:have|has) received/i.test(text); break;
    case "unsupported": pass = (last === null || last?.kind === "clarify" && ["changeUnsupported", "clinicalAdviceUnavailable"].includes(last.reason ?? "")) &&
      /can['’]t|cannot|not supported|contact.*clinic|unavailable/i.test(text) && !statuses.includes("awaitingConfirmation"); break;
    case "constraints":
      if (candidate.id === "CCP-011") { pass = last?.kind === "clarify" && last.reason === "searchPreferenceUnavailable" &&
        last.approvedLocation === "Demo North" && /supports appointments at Demo North.*can’t use/s.test(text) && !statuses.includes("awaitingConfirmation"); break; }
      if (candidate.id === "CCP-025") { pass = last?.kind === "bookingMenu" && last.preference?.practitioner === "Demo B" &&
        /approved practitioners Demo B at Demo North.*with Demo B/s.test(text) && !/with Demo A/.test(text) && !statuses.includes("awaitingConfirmation"); break; }
      pass = candidate.id === "CCP-027" && last?.kind === "bookingMenu" && last.from === "2026-10-08" && last.to === "2026-10-08" &&
        last.window?.startMinute === 960 && last.window.endMinute === 1440 && last.window.startInclusive === false &&
        /after 4:00 pm.*5:00 pm/s.test(text) && !/3:00 pm|option two/.test(text) && !statuses.includes("awaitingConfirmation");
      break;
    case "boundedSearch":
      if (candidate.id === "CCP-026") { pass = last?.kind === "bookingMenu" && last.preference?.practitioner === "any" &&
        last.from === "2026-10-04" && last.to === "2026-10-10" && /Demo A and Demo B.*Sunday 4 October.*Saturday 10 October.*earliest eligible start.*with Demo B/s.test(text) &&
        !statuses.includes("awaitingConfirmation"); break; }
      pass = candidate.id === "CCP-028" && last?.kind === "bookingMenu" && last.from === "2026-10-09" && last.to === "2026-10-11" &&
        /Friday 9 October.*10:00 am/s.test(text) && !/Thursday 8 October/.test(text) && !statuses.includes("awaitingConfirmation");
      break;
    // Other preferences, horizons and public facts remain explicitly unassessed.
    case "publicFacts": pass = last?.kind === "answer" && last.proposedText === publicDirections &&
      after.knowledgeAnswers.length === before.knowledgeAnswers.length + 1 && speech.includes(publicDirections) && !Object.keys(after.actions).length; break;
  }
  return { id: "conversation-observation", pass: pass && !plan.missingSetup,
    detail: `${candidate.pattern}: ${plan.expectation}; this check covers only the named observation, not every prose acceptance condition.` };
}

/** Exercise the same signed HTTP/WS owner, private OTP and SAM/playback path as
 * E2E-303. Setup decisions are pinned; only candidate turns use the live model. */
export async function runCase(db: Kysely<Database>, candidate: Candidate, plan: Plan, model: ModelConfig) {
  const f = candidate.id === "CCP-015" ? await urgentConversationFixture() : candidate.id === "CCP-032" ? await clinicFAQFixture() : plan.stage === "enquiry" ? await appointmentEnquiryFixture() : ["CCP-011", "CCP-025", "CCP-026"].includes(candidate.id) ? await bookingCatalogueFixture() : plan.stage.startsWith("staff") ? await clinikoStaffCallFlowFixture({ lostResponse: plan.stage === "staffUncertain" })
    : plan.stage.startsWith("cancel") ? await cancellationCallFlowFixture({ multiple: candidate.id === "CCP-036" })
    : plan.stage.startsWith("move") ? await reschedulingCallFlowFixture() : await bookingCallFlowFixture();
  f.flow.dispose();
  if ("setStarts" in f) f.setStarts(candidate.id === "CCP-004"
    ? ["2026-10-06T22:00:00.000Z", "2026-10-07T05:30:00.000Z"] : candidate.id === "CCP-006"
    ? ["2026-10-07T23:30:00.000Z", "2026-10-09T11:30:00.000Z"]
    : candidate.id === "CCP-027" ? ["2026-10-08T04:00:00.000Z", "2026-10-08T06:00:00.000Z"]
      : ["2026-10-07T22:00:00.000Z", "2026-10-07T23:30:00.000Z", "2026-10-08T23:00:00.000Z"]);
  // Match the protected target in CCP-010 to the explicit nine-o'clock setup.
  const originalProvider = f.flowConfig.fetchPort!;
  const fetchPort: typeof fetch = candidate.id === "CCP-010" ? async (value, init) => {
    const response = await originalProvider(value, init);
    const path = new URL(String(value)).pathname;
    if ((init?.method ?? "GET") !== "GET" || !path.startsWith("/v1/individual_appointments")) return response;
    const data = await response.json();
    for (const row of Array.isArray(data.individual_appointments) ? data.individual_appointments : [data]) {
      if (row.id === "91") { row.starts_at = "2026-10-07T22:00:00.000Z"; row.ends_at = "2026-10-07T22:30:00.000Z"; }
    }
    return Response.json(data, { status: response.status });
  } : originalProvider;
  let call: Call | undefined, evaluating = false, requests = 0, modelPrivacyPass = true;
  const intents: (VoiceIntent | null)[] = [];
  try {
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort }, owner => {
      const resolve = createOpenAIClinicalIntentResolver({ owner, apiKey: model.apiKey, model: model.model,
        clinicDate: () => "2026-10-04", fetch: async (value, init) => {
          const body = JSON.parse(String(init?.body));
          if (verificationCanaries.some(value => String(init?.body).includes(value))) modelPrivacyPass = false;
          const text = JSON.parse(body.input[1].content).callerText as string;
          if (evaluating && model.mode === "live") { requests++; return fetch(value, init); }
          const answer = evaluating ? decision("unsupported") : setupDecisions[text];
          if (!answer) throw new Error("unregistered synthetic setup turn");
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed",
            content: [{ type: "output_text", text: JSON.stringify(answer) }] }] });
        } });
      return async (turn, signal) => { const result = await resolve(turn, signal);
        if (evaluating) intents.push(result.ok ? result.value : null); return result; };
    }, { lostWrite: plan.stage === "uncertain" });
    await prepare(call, plan, f.mail, candidate.id);
    const before = await call.state(), writes = call.writes.length, speechStart = call.spoken.length;
    const context = await call.flow.publicIntentContext();
    evaluating = true;
    for (const text of candidate.callerTurns) { await call.turn(text); await call.mark(); }
    const after = await call.state(), speech = call.spoken.slice(speechStart);
    const statuses = Object.values(after.actions).map(action => action.status);
    const checks: Check[] = [
      { id: "private-fields-absent-from-model", pass: modelPrivacyPass, detail: "Synthetic email, chart and patient-ID canaries must not enter any structured model request." },
      { id: "no-unconfirmed-provider-write", pass: call.writes.length === writes, detail: "Candidate turns contain no separate exact affirmative; provider write count must remain unchanged." },
      { id: "preserve-known-outcome", pass: Object.values(before.actions).filter(action => ["committed", "uncertain"].includes(action.status))
        .every(action => after.actions[action.key]?.status === action.status), detail: "A new turn cannot revise a known prior SAM receipt." },
      conversationCheck(candidate, plan, intents, speech, before, after),
    ];
    return { id: candidate.id, pattern: candidate.pattern, priority: candidate.priority, mode: model.mode,
      status: "executed" as const, fixtureStage: plan.stage, setupMatch: !plan.missingSetup,
      setupGap: plan.missingSetup ?? null, requests, context, intents: intents.map(publicIntent), setupSpeech: call.spoken.slice(0, speechStart), speech, actionStatuses: statuses,
      writesBefore: writes, writesAfter: call.writes.length, checks,
      acceptance: "partial-not-a-release-gate", unassessedRequiredBehavior: candidate.requiredBehavior,
      unassessedForbiddenBehavior: candidate.forbiddenBehavior };
  } finally { try { await call?.close(); } finally { await f.close(); } }
}
