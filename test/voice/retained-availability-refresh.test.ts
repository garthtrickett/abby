import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCatalogueFixture } from "../support/cliniko-booking-catalogue.ts";
import { reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const old = "2026-11-03T02:30:00.000Z", fresh = "2026-11-04T03:15:00.000Z";
const excluded = ["2026-10-16T03:00:00.000Z", "2026-11-03T22:00:00.000Z"];

test("E2E-333 a caller-requested refresh after a vanished slot retains November, afternoon, approved location and practitioner without guessing", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async db => {
    const modes = ["book", "empty", "move", "moveDenied", "moveChanged", "unplayed", "noPrevious"] as const;
    const run = async (mode: typeof modes[number]) => {
      const moving = mode.startsWith("move"), f = moving ? await reschedulingCallFlowFixture() : await bookingCatalogueFixture();
      f.flow.dispose();
      if ("replacePolicy" in f) await f.replacePolicy({ maxAdvanceDays: 90 });
      const approvalPaths = "alternatePath" in f ? [f.alternatePath] : [f.destinationPath];
      for (const path of approvalPaths) {
        const approval = JSON.parse(await readFile(path, "utf8"));
        await writeFile(path, JSON.stringify({ ...approval, maxAdvanceDays: 90 }), { mode: 0o600 });
      }
      f.setStarts([old, ...excluded]); if ("setAlternateStarts" in f) f.setAlternateStarts([old, ...excluded]);
      const queries: { path: string; from: string | null; to: string | null }[] = [];
      const modelRequests: string[] = [];
      const menuResults: unknown[] = [];
      const original = f.flowConfig.fetchPort!;
      const fetchPort: typeof fetch = async (value, init) => {
        const url = new URL(String(value));
        if (url.pathname.endsWith("/available_times")) queries.push({ path: url.pathname, from: url.searchParams.get("from"), to: url.searchParams.get("to") });
        return original(value, init);
      };
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      try {
        call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort }, owner => createOpenAIClinicalIntentResolver({ owner,
          apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            modelRequests.push(text);
            const start = text === "I need to book an appointment." || text === "I need to move an appointment.";
            const targets = text === "Show my existing appointments from October 4 through October 9.";
            const november = text === "What times are available from November 2 through November 8?";
            // A classifier fallback deliberately suggests October. A refresh
            // must use the call's actual prior search, never this guessed range.
            const guess = { kind: start ? "workflow" : "menu", operation: start ? moving ? "reschedule" : "book" : null,
              stage: start || !moving ? null : targets ? "targets" : "offers",
              from: start ? null : targets ? "2026-10-04" : november ? "2026-11-02" : "2026-10-16",
              to: start ? null : targets ? "2026-10-09" : november ? "2026-11-08" : "2026-10-16", choice: null };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(guess) }] }] });
          } }));
        const read = call.flow.readBookingMenu.bind(call.flow);
        call.flow.readBookingMenu = async query => {
          const result = await read(query);
          menuResults.push(result.ok ? { choices: result.value.choices.length, window: result.value.window, searchScope: result.value.searchScope } : result.error);
          return result;
        };
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        await play(moving ? "I need to move an appointment." : "I need to book an appointment.");
        await voiceUntil(() => f.mail.length === 1, "refresh private verification"); await call.verify(f.mail[0]!.code);
        if (mode === "noPrevious") {
          const before = queries.length;
          await call.turn("Please check again.");
          assert.equal(queries.length, before); assert.match(call.spoken.at(-1)!, /fresh appointment options/);
          assert.equal(call.writeRequests.length, 0); return;
        }
        if (moving) {
          await play("Show my existing appointments from October 4 through October 9."); await play("My first existing appointment.");
        } else {
          await play("I prefer Demo B.");
          await play("I need the other branch, Demo North.");
          assert.match(call.spoken.at(-1)!, /practitioners Demo B at Demo North/);
        }
        await play("What times are available from November 2 through November 8?"); await play("Afternoon, please.");
        assert.match(call.spoken.at(-1)!, /November.*1:30 pm/s);
        const refreshedStarts = (mode === "empty" ? [...excluded] : [fresh, ...excluded]).sort();
        f.setStarts(refreshedStarts);
        if ("setAlternateStarts" in f) f.setAlternateStarts(refreshedStarts);
        await play("The first time, please.");
        assert.equal(call.writeRequests.length, 0); assert.equal(Object.keys((await call.state()).actions).length, 0);
        if (mode === "moveDenied") f.setPermitted(false);
        if (mode === "moveChanged") f.setFailure("practitioner");
        const before = queries.length, models = modelRequests.length;
        await call.turn("Please check again.");
        assert.ok(call.transcripts.includes("Please check again."));
        assert.equal(modelRequests.length, models, `refresh syntax bypasses model date guesses: ${JSON.stringify(queries.slice(before))}`);
        if (mode === "moveDenied" || mode === "moveChanged") {
          assert.equal(queries.length, before, "revoked proof or changed source blocks destination lookup");
          assert.equal(Object.keys((await call.state()).actions).length, 0); assert.equal(call.writeRequests.length, 0);
          assert.match(call.spoken.at(-1)!, /fresh options|contact the clinic|fresh appointment options/); return;
        }
        assert.ok(queries.length > before, "refresh must actually reread availability");
        assert.ok(queries.slice(before).every(query => query.from === "2026-11-02" && query.to === "2026-11-08" &&
          query.path.includes(`/businesses/11/practitioners/${moving ? "22" : "23"}/`)), "exact retained range/location/practitioner");
        if (mode === "empty") {
          assert.match(call.spoken.at(-1)!, /couldn't find|contact the clinic/);
          assert.doesNotMatch(call.spoken.at(-1)!, /October|9:00 am|option one/);
          await call.mark(); await call.turn("Yes");
          assert.equal(call.writeRequests.length, 0); return;
        }
        assert.match(call.spoken.at(-1)!, /November.*2:15 pm/s, JSON.stringify(menuResults));
        assert.doesNotMatch(call.spoken.at(-1)!, /October|9:00 am|1:30 pm/);
        if (mode === "unplayed") {
          await call.turn("The first time, please.", { interrupt: true });
          assert.equal(Object.keys((await call.state()).actions).length, 0); assert.equal(call.writeRequests.length, 0);
          assert.match(call.spoken.at(-1)!, /fresh appointment options/); return;
        }
        await call.mark(); await call.turn("The first time, please.");
        const action = Object.values((await call.state()).actions).at(-1)!;
        assert.equal(action.status, "awaitingConfirmation"); assert.equal(call.writeRequests.length, 0);
        assert.match(call.spoken.at(-1)!, /November.*2:15 pm/s);
        await call.mark(); await play("Yes");
        assert.equal(call.writeRequests.length, 1); const write = call.writeRequests[0]!;
        assert.equal(write.body.starts_at, fresh); assert.equal(write.method, moving ? "PATCH" : "POST");
        assert.equal(write.path, moving ? "/v1/individual_appointments/91" : "/v1/individual_appointments");
        if (!moving) { assert.equal(write.body.patient_id, verificationCanaries[2]); assert.equal(write.body.practitioner_id, "23"); assert.equal(write.body.business_id, "11"); }
        assert.equal((await call.state()).actions[action.key]?.status, "committed");
        const sent = queries.length; await call.turn("Please check again.");
        assert.equal(queries.length, sent); assert.equal(call.writeRequests.length, 1);
        assert.match(call.spoken.at(-1)!, /confirmed|rescheduled/); assert.match(call.spoken.at(-1)!, /haven't made another change/);
      } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { await call?.close(); await f.close(); }
    };
    let next = 0; const failures: unknown[] = [];
    const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const mode = modes[next++]; if (!mode) return; try { await run(mode); } catch (error) { failures.push(error); } } }));
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `retained_refresh_${index}`, value })))), []);
  });
});
