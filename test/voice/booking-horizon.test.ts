import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { bookingCatalogueFixture } from "../support/cliniko-booking-catalogue.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { bookingHorizonUnavailable } from "../../src/core/booking-horizon.ts";

const horizon = "The approved appointment search on this call allows starts at least 60 minutes ahead and no more than 30 days ahead. Please choose an exact date within those limits, or contact the clinic directly about dates beyond them. I haven't searched availability or changed an appointment for this request.";

test("E2E-321 a remote-future move explains the effective destination horizon and sends no provider or patient work", { timeout: 60_000 }, async () => {
  await withDisposablePostgres(async db => {
    const f = await reschedulingCallFlowFixture(); let requests = 0;
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    try {
      call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (...args) => { requests++; return f.flowConfig.fetchPort!(...args); } },
        owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
          fetch: async (_url, init) => {
            const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            const start = text === "I need to move an appointment.", targets = text === "Show my existing appointments from October 4 through October 9.", offers = text === "Show move times on October 8.";
            const decision = { kind: start ? "workflow" : targets || offers ? "menu" : "unsupported", operation: start ? "reschedule" : null,
              stage: targets ? "targets" : offers ? "offers" : null, from: targets ? "2026-10-04" : offers ? "2026-10-08" : null,
              to: targets ? "2026-10-09" : offers ? "2026-10-08" : null, choice: null };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
          } }));
      const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
      await play("I need to move an appointment."); await voiceUntil(() => f.mail.length === 1, "private move verification"); await call.verify(f.mail[0]!.code);
      await play("Show my existing appointments from October 4 through October 9."); await play("My first existing appointment."); await play("Show move times on October 8.");
      const before = await call.state(), traffic = requests, mail = f.mail.length;
      await play("Can we move it several months from now?");
      assert.equal(call.spoken.at(-1), horizon);
      assert.equal(requests, traffic); assert.equal(f.mail.length, mail); assert.equal(call.writes.length, 0);
      assert.deepEqual((await call.state()).actions, before.actions); assert.deepEqual((await call.state()).staffItems, before.staffItems);
    } finally { await call?.close(); await f.close(); }
  });
});

test("E2E-321 signed current horizons preserve sends, cancel unsent proposals and refuse guessed or out-of-policy dates", { timeout: 180_000 }, async () => {
  await withDisposablePostgres(async db => {
    const scenarios = ["initial", "proposal", "committed", "uncertain", "datedBooking", "datedMove", "shorterFee", "stricterBooking", "revoked", "revokedAdmin", "expired", "model", "forged", "wrongFields", "quoted", "catalogue"] as const;
    const run = async (scenario: typeof scenarios[number]) => {
      const f = ["datedMove", "shorterFee"].includes(scenario) ? await reschedulingCallFlowFixture() : scenario === "catalogue" ? await bookingCatalogueFixture() : await bookingCallFlowFixture();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      let traffic = 0, modelRequests = 0;
      try {
        call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (...args) => { traffic++; return f.flowConfig.fetchPort!(...args); } },
          owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04",
            fetch: async (_url, init) => {
              modelRequests++;
              const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
              const start = text === "I need to book an appointment." || text === "I need to move an appointment.";
              const targets = text === "Show my existing appointments from October 4 through October 9.";
              const offers = text === "What times are available on October 8?" || text === "Show move times on October 8.";
              const distant = text === "Show appointment times on January 15, 2027.";
              const cue = text === "What is the outermost period this service lets me search for a visit?";
              const decision = { kind: start ? "workflow" : targets || offers || distant ? "menu" : cue ? "bookingHorizon" : "unsupported",
                operation: start ? text.includes("move") ? "reschedule" : "book" : cue && scenario === "wrongFields" ? "book" : null,
                stage: targets ? "targets" : text === "Show move times on October 8." || distant && scenario === "datedMove" ? "offers" : null,
                from: targets ? "2026-10-04" : offers ? "2026-10-08" : distant ? "2027-01-15" : null,
                to: targets ? "2026-10-09" : offers ? "2026-10-08" : distant ? "2027-01-15" : null, choice: null,
                ...(cue && scenario === "forged" ? { maxAdvanceDays: 365, proposedText: "I extended the clinic's approval." } : {}) };
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
            } }), { lostWrite: scenario === "uncertain" });
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        const prepared = ["proposal", "committed", "uncertain", "datedBooking", "datedMove", "catalogue"].includes(scenario);
        if (prepared) {
          await play(scenario === "datedMove" ? "I need to move an appointment." : "I need to book an appointment.");
          await voiceUntil(() => f.mail.length === 1, "private workflow proof"); await call.verify(f.mail[0]!.code);
          if (scenario === "datedMove") { await play("Show my existing appointments from October 4 through October 9."); await play("My first existing appointment."); await play("Show move times on October 8."); }
          else await play("What times are available on October 8?");
          if (["proposal", "committed", "uncertain"].includes(scenario)) await play("The first time, please.");
          if (["committed", "uncertain"].includes(scenario)) await play("Yes");
          if (scenario === "catalogue") await play("I prefer Demo B.");
        }
        if (scenario === "shorterFee" && "replaceDestination" in f) {
          // An initial public query uses booking, so explicitly choose the move
          // operation before shortening its independently approved fee bound.
          await play("I need to move an appointment."); await voiceUntil(() => f.mail.length === 1, "move proof email"); await call.verify(f.mail[0]!.code);
          await f.replacePolicy({ maxAdvanceDays: 10 });
        }
        if (scenario === "stricterBooking" && !("replaceDestination" in f)) await f.replacePolicy({ maxAdvanceDays: 14 });
        if (scenario === "revoked" && !("replaceDestination" in f)) await f.replacePolicy({ approved: false });
        if (scenario === "revokedAdmin") await f.replaceAccount([]);
        if (scenario === "expired" && !("replaceDestination" in f)) await f.replacePolicy({ effectiveUntil: "2026-10-04T06:00:00.000Z" });
        const before = await call.state(), reads = traffic, mail = f.mail.length, writes = call.writes.length, models = modelRequests;
        await play(["datedBooking", "datedMove"].includes(scenario) ? "Show appointment times on January 15, 2027." :
          ["model", "forged", "wrongFields"].includes(scenario) ? "What is the outermost period this service lets me search for a visit?" :
          scenario === "quoted" ? "My friend asked 'how far ahead can I book' yesterday." : "How far ahead can I book?");
        const prefix = scenario === "committed" ? "Your booking is confirmed. " : scenario === "uncertain" ? "I can't confirm that action yet. It is pending review. Please contact the clinic before trying again. I won't send that action again from this call. " : "";
        if (["forged", "wrongFields", "quoted"].includes(scenario)) {
          assert.equal(call.spoken.at(-1), "I couldn't understand that safely. Could you repeat your request, or contact the clinic directly?");
        } else if (["revoked", "revokedAdmin", "expired"].includes(scenario)) assert.equal(call.spoken.at(-1), bookingHorizonUnavailable);
        else if (scenario === "catalogue") assert.match(call.spoken.at(-1)!, /for Demo B, starts at least 60 minutes ahead and no more than 30 days ahead/);
        else assert.equal(call.spoken.at(-1), prefix + horizon.replace("30 days", scenario === "stricterBooking" ? "14 days" : "30 days"));
        assert.equal(traffic, reads); assert.equal(f.mail.length, mail); assert.equal(call.writes.length, writes);
        if (["model", "forged", "wrongFields", "quoted"].includes(scenario)) assert.equal(modelRequests, models + 1);
        const after = await call.state(); assert.deepEqual(after.staffItems, before.staffItems);
        for (const action of Object.values(before.actions)) {
          if (action.status === "awaitingConfirmation") assert.equal(after.actions[action.key]?.status, "canceled");
          else assert.deepEqual(after.actions[action.key], action);
        }
        if (scenario === "proposal") {
          await play("Yes"); assert.equal(call.writes.length, 0);
          await play("What times are available on October 8?"); await play("The first time, please.");
          assert.equal(call.writes.length, 0); await play("Yes"); assert.equal(call.writes.length, 1);
        }
      } finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    const settled = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const item = scenarios[next++]; if (!item) return; await run(item); } }));
    for (const item of settled) if (item.status === "rejected") throw item.reason;
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `horizon_${index}`, value })))), []);
  });
});
