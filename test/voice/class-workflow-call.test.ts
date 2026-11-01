import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { classCallFlowFixture } from "../support/class-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";

test("E2E-394 actual signed class booking and cancellation use normal clinical classifier, private keypad and inspected attendance", { timeout: 120_000 }, async t => {
  await withDisposablePostgres(async db => {
    for (const operation of ["book", "cancel"] as const) for (const lost of [false, true]) {
      await t.test(`${operation}: ${lost ? "lost native response" : "confirmed"}`, async () => {
        const f = await classCallFlowFixture(operation); f.flow.dispose();
        let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
        const publicModel: Record<string, unknown>[] = [];
        try {
          if (operation === "book" && !lost) f.native.groups.push({ ...structuredClone(f.native.groups[3]!), id: "95",
            links: { self: "https://api.au5.cliniko.com/v1/group_appointments/95" }, starts_at: "2026-10-08T11:30:00.000Z", ends_at: "2026-10-08T12:30:00.000Z" });
          const start = operation === "book" ? "I would like to reserve a place in Mat Pilates." : "I would like to withdraw from Mat Pilates.";
          const model: typeof fetch = async (_url, init) => {
            const body = JSON.parse(String(init?.body)), context = JSON.parse(body.input[1].content);
            publicModel.push(context);
            assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
            assert.deepEqual(context.classService, { className: "Mat Pilates", practitionerName: "Demo Instructor", locationName: "Demo Clinic", serviceRef: "mat-pilates" });
            const decision = { kind: "unsupported", operation: null as string | null, stage: null, from: null as string | null, to: null as string | null, choice: null as number | null };
            if (context.callerText === start) { decision.kind = "classWorkflow"; decision.operation = operation; }
            else if (context.callerText === "Show class times on October 8.") { decision.kind = "menu"; decision.from = "2026-10-08"; decision.to = "2026-10-08"; }
            else if (context.callerText === "The first time please.") { decision.kind = "choice"; decision.choice = 1; }
            else if (context.callerText === "Show my class bookings from October 4 through October 9.") { decision.kind = "appointments"; decision.from = "2026-10-04"; decision.to = "2026-10-09"; }
            else assert.fail("unexpected public classifier request");
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
          };
          call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, flow => createOpenAIClinicalIntentResolver({ apiKey: "synthetic-class-intent", model: "synthetic-model",
            clinicDate: () => "2026-10-04", owner: flow, fetch: model }), { lostWrite: lost });
          f.bindNativeCall(() => call!.state());
          await call.turn(start); assert.match(call.spoken.at(-1)!, /six-digit code.*keypad/); await call.mark();
          await voiceUntil(() => f.mail.length === 1, "class operation verification email");
          const privateFrames = call.transcriptionFrames;
          await call.verify(f.mail[0]!.code);
          assert.equal(call.transcriptionFrames, privateFrames);
          if (operation === "book") {
            await call.turn("Show class times on October 8."); await call.mark(); await call.turn("The first time please.");
          } else {
            await call.turn("Show my class bookings from October 4 through October 9."); await call.mark(); await call.turn("Cancel that appointment.");
          }
          let action = Object.values((await call.state()).actions).at(-1)!;
          assert.equal(action.status, "awaitingConfirmation"); assert.equal(call.writes.length, 0); assert.equal(f.recalls.length, 0);
          if (operation === "book" && !lost) {
            const previousKey = action.key;
            await call.turn("No, the second time please.", { interrupt: true });
            const corrected = await call.state();
            assert.equal(corrected.actions[previousKey]!.status, "canceled");
            action = Object.values(corrected.actions).at(-1)!;
            assert.equal(action.status, "awaitingConfirmation", JSON.stringify({ phase: "class-correction", claims: f.claims, lastSpeech: call.spoken.at(-1), statuses: Object.values(corrected.actions).map(item => item.status) })); assert.notEqual(action.key, previousKey);
            assert.equal(action.mutation.request.kind, "book");
            if (action.mutation.request.kind !== "book") assert.fail("class correction lost booking action");
            assert.equal(action.mutation.request.offer.startsAt, "2026-10-08T11:30:00.000Z");
            assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
          }
          assert.match(call.spoken.at(-1)!, /Mat Pilates/);
          assert.match(call.spoken.at(-1)!, operation === "book" ? /12 pounds/ : /No cancellation fee/);
          await call.mark(); await call.turn("Yes");
          assert.equal(Object.values((await call.state()).actions).at(-1)!.status, lost ? "uncertain" : "committed", JSON.stringify({ phase: "class-write", claims: f.claims, writes: f.writes.length, recalls: f.recalls.length, transportWrites: call.writes.length }));
          assert.deepEqual(call.writes, [operation === "book" ? "POST /v1/attendees" : "PATCH /v1/attendees/101/cancel"]);
          assert.equal(f.writes.length, 1); assert.equal(f.recalls.length, 1); assert.ok(f.claims <= 200);
          const review = resultValue(decodeClinikoReview(f.recalls[0]!.notes));
          assert.equal(review.request.operation.kind, operation === "book" ? "classBook" : "classCancel");
          if (operation === "book" && !lost) assert.equal(call.writeRequests[0]!.body.booking_id, "95");
          if (lost) {
            assert.match(call.spoken.at(-1)!, /can't confirm|couldn't confirm|not confirmed|unconfirmed/i);
            await call.mark(); await call.turn("Yes");
            assert.equal(f.writes.length, 1);
          } else assert.match(call.spoken.at(-1)!, /confirmed/);
          for (const secret of [f.mail[0]!.code, ...verificationCanaries]) assert.equal(JSON.stringify([publicModel, call.modelTurns, call.transcripts, call.spoken]).includes(secret), false);
        } finally { if (call) await call.close(); await f.close(); }
      });
    }
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `class_${index}`, value })))), []);
  });
});

test("E2E-394 actual emitted signed class read cannot publish after verified call retirement", { timeout: 30_000 }, async () => {
  const emitted = new URL("../../dist/runtime/", import.meta.url);
  const { classCallFlowFixture: emittedClassFixture } = await import(new URL("test/support/class-call-flow.js", emitted).href) as typeof import("../support/class-call-flow.ts");
  const { clinikoWorkflowVoiceFixture: emittedVoiceFixture } = await import(new URL("test/support/cliniko-workflow-voice.js", emitted).href) as typeof import("../support/cliniko-workflow-voice.ts");
  const { createOpenAIClinicalIntentResolver: emittedResolver } = await import(new URL("src/standalone/openai-clinical-intent.js", emitted).href) as typeof import("../../src/standalone/openai-clinical-intent.ts");
  await withDisposablePostgres(async db => {
    const f = await emittedClassFixture("cancel"); f.flow.dispose();
    let call: Awaited<ReturnType<typeof emittedVoiceFixture>> | undefined;
    let armed = false, held = false, returned = false, release = () => {};
    const waiting = new Promise<void>(resolve => { release = resolve; });
    try {
      const original = f.flowConfig.fetchPort!;
      const config = { ...f.flowConfig, fetchPort: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await original(input, init);
        if (armed && !held && (init?.method ?? "GET") === "GET" && new URL(String(input)).pathname === "/v1/group_appointments") {
          assert.equal(response.status, 200);
          held = true; await waiting; returned = true;
        }
        return response;
      } };
      const start = "I would like to withdraw from Mat Pilates.";
      call = await emittedVoiceFixture(db, config, owner => emittedResolver({ owner,
        apiKey: "synthetic-class-retirement", model: "synthetic-model", clinicDate: () => "2026-10-04",
        fetch: async (_input, init) => {
          const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
          assert.ok([start, "Show my class bookings from October 4 through October 9."].includes(text));
          const begin = text === start;
          const decision = { kind: begin ? "classWorkflow" : "appointments", operation: begin ? "cancel" : null,
            stage: null, from: begin ? null : "2026-10-04", to: begin ? null : "2026-10-09", choice: null };
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
        } }));
      await call.turn(start); await call.mark();
      await voiceUntil(() => f.mail.length === 1, "class retirement private verification email");
      await call.verify(f.mail[0]!.code);
      assert.equal(call.flow.verificationRequired, false);
      assert.equal(call.writeRequests.length, 0);
      armed = true;
      const pending = call.turn("Show my class bookings from October 4 through October 9.").then(() => undefined, error => error);
      await voiceUntil(() => held, "held successful native class appointment response");
      call.flow.dispose(); await pending;
      const beforeLate = await call.state(), spokenBeforeLate = [...call.spoken];
      assert.ok(beforeLate.appointmentReads.some(read => read.status === "failed"));
      assert.deepEqual(beforeLate.actions, {});
      assert.equal(call.writeRequests.length, 0);
      release(); await voiceUntil(() => returned, "late successful native class appointment response");
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(await call.state(), beforeLate);
      assert.deepEqual(call.spoken, spokenBeforeLate);
      assert.doesNotMatch(call.spoken.join(" "), /I found an appointment|couldn't find an appointment|booking is confirmed/i);
      assert.equal(call.writeRequests.length, 0);
      assert.deepEqual([f.writes.length, f.recalls.length], [0, 0]);
      await call.close(); call = undefined;
      assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `class_retirement_${index}`, value })))), []);
    } finally {
      release();
      try { await call?.close(); } finally { await f.close(); }
    }
  });
});
