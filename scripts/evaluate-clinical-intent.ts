import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { clinicalIntentPromptVersion, createOpenAIClinicalIntentResolver } from "../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture, cancellationCallFlowFixture, reschedulingCallFlowFixture, intakeCallFlowFixture } from "../test/support/cliniko-call-flow.ts";
import { publicInformationUnavailable } from "../src/core/public-information.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--model" || args[2] !== "--out" || !args[1]?.trim() || !args[3]?.trim())
    throw new Error("usage: --model MODEL --out REPORT");
  const key = process.env.ABBY_OPENAI_API_KEY;
  if (!key) throw new Error("missing model key");
  const cases = [
    { name: "book", text: "I need to book an appointment.", expected: { kind: "workflow", operation: "book" }, fixture: bookingCallFlowFixture },
    { name: "cancel", text: "I need to cancel an appointment.", expected: { kind: "workflow", operation: "cancel" }, fixture: cancellationCallFlowFixture },
    { name: "reschedule", text: "I need to move an appointment.", expected: { kind: "workflow", operation: "reschedule" }, fixture: reschedulingCallFlowFixture },
    { name: "new-patient", text: "I'm new to this clinic and want to register.", expected: { kind: "workflow", operation: "intake" }, fixture: intakeCallFlowFixture },
    { name: "identity-disagreement-paraphrase", text: "You have linked this conversation to somebody different from its speaker.",
      expected: { kind: "callerIdentityDenied", reason: "identityDisagreement" }, fixture: bookingCallFlowFixture },
    { name: "shared-phone-paraphrase", text: "My partner and I both use the number I am ringing from.",
      expected: { kind: "callerIdentityDenied", reason: "sharedPhone" }, fixture: bookingCallFlowFixture },
    { name: "shared-line-model-paraphrase", text: "More than one person uses the line I am calling you on.",
      expected: { kind: "callerIdentityDenied", reason: "sharedPhone" }, fixture: bookingCallFlowFixture },
    { name: "minor-intake-model-paraphrase", text: "Please enroll the youngster I care for.",
      expected: { kind: "requestBoundary", reason: "minorIntake" }, fixture: bookingCallFlowFixture },
    { name: "proxy-patient-model-paraphrase", text: "Please rearrange the visit of the other member of my household.",
      expected: { kind: "requestBoundary", reason: "proxyPatient" }, fixture: bookingCallFlowFixture },
    { name: "joint-practitioner-model-paraphrase", text: "Can several providers take part in a shared session with me?",
      expected: { kind: "requestBoundary", reason: "jointPractitioners" }, fixture: bookingCallFlowFixture },
    { name: "group-class-model-paraphrase", text: "Could you remove me from this evening's Pilates cohort?",
      expected: { kind: "requestBoundary", reason: "groupClass" }, fixture: bookingCallFlowFixture },
    { name: "group-class-unavailable-model-paraphrase", text: "I can't make the shared Pilates session with the other participants this evening.",
      expected: { kind: "requestBoundary", reason: "groupClass" }, fixture: bookingCallFlowFixture },
    { name: "own-booking-with-background-partner", text: "My partner has an appointment already. I want to book a separate appointment for myself.",
      expected: { kind: "workflow", operation: "book" }, fixture: bookingCallFlowFixture },
    { name: "own-booking-single-practitioner", text: "I don't need two clinicians; just book one practitioner for my own visit.",
      expected: { kind: "workflow", operation: "book" }, fixture: bookingCallFlowFixture },
    { name: "booking-horizon-trusted", text: "How far ahead can I book?", expected: { kind: "bookingHorizon" }, fixture: bookingCallFlowFixture },
    { name: "booking-horizon-model-paraphrase", text: "What is the outermost period this service lets me search for a visit?",
      expected: { kind: "bookingHorizon" }, fixture: bookingCallFlowFixture },
    { name: "background-horizon-question", text: "My friend asked 'how far ahead can I book' yesterday.",
      expected: { kind: "intentUnavailable" }, fixture: bookingCallFlowFixture },
    { name: "outcome", text: "Did that action work?", expected: { kind: "outcome" }, fixture: bookingCallFlowFixture },
    { name: "service-guidance-trusted", text: "I do not know which appointment type I need.",
      expected: { kind: "answer", sourceRefs: ["clinic-public-serviceGuidance"], proposedText: publicInformationUnavailable("serviceGuidance") }, fixture: bookingCallFlowFixture },
    { name: "service-guidance-model-paraphrase", text: "Could you explain the different visit categories?",
      expected: { kind: "answer", sourceRefs: ["clinic-public-serviceGuidance"], proposedText: publicInformationUnavailable("serviceGuidance") }, fixture: bookingCallFlowFixture },
    { name: "service-guidance-symptoms", text: "My knee hurts. Which appointment type should I book?",
      expected: { kind: "answer", sourceRefs: ["clinic-public-serviceGuidance"], proposedText: publicInformationUnavailable("serviceGuidance") }, fixture: bookingCallFlowFixture },
    { name: "price-and-fees-trusted", text: "What would this visit cost, and would I pay a fee to cancel?",
      expected: { kind: "answer", sourceRefs: ["clinic-public-priceAndFees"], proposedText: publicInformationUnavailable("priceAndFees") }, fixture: bookingCallFlowFixture },
    { name: "price-and-fees-model-paraphrase", text: "What charges might a consultation and its cancellation attract?",
      expected: { kind: "answer", sourceRefs: ["clinic-public-priceAndFees"], proposedText: publicInformationUnavailable("priceAndFees") }, fixture: bookingCallFlowFixture },
    { name: "reported-service-question", text: "My friend asked 'which appointment type do I need' yesterday.", expected: { kind: "intentUnavailable" }, fixture: bookingCallFlowFixture },
    { name: "negated-service-question", text: "I am not asking for service descriptions.", expected: { kind: "intentUnavailable" }, fixture: bookingCallFlowFixture },
    { name: "invoice-copy-trusted", text: "Could the clinic send my paid receipt again?", expected: { kind: "staffRequest", requestSubject: "invoiceCopy" }, fixture: bookingCallFlowFixture },
    { name: "charge-review-trusted", text: "I arrived on the day I was told. Could someone review the charge before I arrange another visit?", expected: { kind: "staffRequest", requestSubject: "chargeReview" }, fixture: bookingCallFlowFixture },
    { name: "waitlist-interest-trusted", text: "If a slot opens sooner, could you put me on a list and call me?", expected: { kind: "staffRequest", requestSubject: "waitlistInterest" }, fixture: bookingCallFlowFixture },
    { name: "invoice-copy-model-paraphrase", text: "Could somebody arrange another copy of my settled account paperwork?", expected: { kind: "staffRequest", requestSubject: "invoiceCopy" }, fixture: bookingCallFlowFixture },
    { name: "charge-review-model-paraphrase", text: "I dispute the amount billed for my visit; please have it investigated before I make any new appointment.", expected: { kind: "staffRequest", requestSubject: "chargeReview" }, fixture: bookingCallFlowFixture },
    { name: "waitlist-interest-model-paraphrase", text: "Please register my interest in being notified if an earlier vacancy becomes available.", expected: { kind: "staffRequest", requestSubject: "waitlistInterest" }, fixture: bookingCallFlowFixture },
    { name: "reported-invoice-question", text: "My friend asked 'could the clinic send my paid receipt again' yesterday.", expected: { kind: "intentUnavailable" }, fixture: bookingCallFlowFixture },
    { name: "negated-invoice-question", text: "I don't need an invoice copy or a refund.", expected: { kind: "intentUnavailable" }, fixture: bookingCallFlowFixture },
    { name: "presence-trusted", text: "Are you still there?", expected: { kind: "presence" }, fixture: bookingCallFlowFixture },
    { name: "presence-model-paraphrase", text: "Have we lost our connection, or are you able to hear me?", expected: { kind: "presence" }, fixture: bookingCallFlowFixture },
    { name: "reported-presence-question", text: "My friend asked 'are you still there' yesterday.", expected: { kind: "intentUnavailable" }, fixture: bookingCallFlowFixture },
    { name: "negated-presence-own-booking", text: "I am not asking if you can hear me. I want to book an appointment for myself.", expected: { kind: "workflow", operation: "book" }, fixture: bookingCallFlowFixture },
  ] as const;
  const results = await Promise.all(cases.map(async item => {
    const f = await item.fixture();
    try {
      let requests = 0;
      const resolveIntent = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: key, model: args[1]!,
        clinicDate: () => "2026-10-04", fetch: async (...args) => { requests++; return fetch(...args); } });
      const result = await resolveIntent(f.turn(`live-${item.name}`, item.text));
      const actual = result.ok ? result.value : { kind: "intentUnavailable" };
      return { name: item.name, requests, pass: JSON.stringify(actual) === JSON.stringify(item.expected), expected: item.expected, actual };
    } finally { f.flow.dispose(); await f.close(); }
  }));
  const adapter = await Promise.all(["src/standalone/openai-clinical-intent.ts", "src/standalone/cliniko-call-flow.ts", "src/standalone/caller-identity-language.ts", "src/standalone/appointment-change-language.ts", "src/standalone/request-boundary-language.ts", "src/core/request-boundary.ts", "src/standalone/booking-horizon-language.ts", "src/standalone/cliniko-booking-horizon.ts", "src/core/booking-horizon.ts", "src/standalone/clinic-information-language.ts", "src/standalone/owner-file-clinic-faqs.ts", "src/core/public-information.ts", "src/standalone/staff-request-language.ts", "src/standalone/staff-request-subject-language.ts", "src/core/staff-request-subject.ts", "src/core/conversation-presence.ts"]
    .map(path => readFile(resolve(path))));
  const hash = createHash("sha256"); for (const source of adapter) hash.update(source);
  const report = { version: 1, kind: "clinical-intent-live-evaluation", at: new Date().toISOString(), model: args[1],
    promptVersion: clinicalIntentPromptVersion, adapterSha256: hash.digest("hex"),
    gate: "classification-sample-only", pass: results.filter(item => item.pass).length, total: results.length, results };
  await mkdir(dirname(resolve(args[3]!)), { recursive: true });
  await writeFile(resolve(args[3]!), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify({ pass: report.pass, total: report.total, gate: report.gate, output: resolve(args[3]!) })}\n`);
  if (report.pass !== report.total) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write("Clinical intent evaluation failed; inspect the owner-only report or provider configuration.\n");
  process.exitCode = 1;
});
