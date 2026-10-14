import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 };
type Call = Parameters<Parameters<typeof withClinicalRunner>[1]>[0];
const attendances = (call: Call) => call.mutations.filter(row => row.path?.startsWith("/v1/attendees"));
const prepare = async (call: Call, operation: "book" | "cancel") => {
  await call.say("Start"); assert.match(call.spoken.at(-1)!, /six-digit code.*keypad/); await call.mark(); await call.verify();
  if (operation === "book") { await call.say("Times"); await call.mark(); await call.say("The first time please."); }
  else { await call.say("Appointments"); await call.mark(); await call.say("Cancel that appointment."); }
  assert.match(call.spoken.at(-1)!, /Mat Pilates/);
  assert.match(call.spoken.at(-1)!, operation === "book" ? /12 pounds/ : /No cancellation fee/);
  assert.equal(call.mutations.length, 0, "a prepared class action cannot write before played terms and affirmative consent");
};

describe("actual compiled class attendance runner", { concurrency: 2 }, () => {
  for (const operation of ["book", "cancel"] as const) for (const lost of [false, true])
    test(`E2E-395 compiled class ${operation} ${lost ? "unknown response" : "exact inspected receipt"} through the normal host factory and shared request budget`, options, async () => {
      await withClinicalRunner(operation, async call => {
        await prepare(call, operation); await call.mark();
        if (lost) call.child.send({ kind: "loseWrite" });
        await call.say("Yes");
        const writes = attendances(call); assert.equal(writes.length, 1);
        assert.equal(writes[0]!.method, operation === "book" ? "POST" : "PATCH");
        assert.equal(writes[0]!.path, operation === "book" ? "/v1/attendees" : "/v1/attendees/101/cancel");
        assert.equal(call.mutations.some(row => row.path?.startsWith("/v1/individual_appointments")), false);
        assert.equal(call.messages.some(row => row.kind === "providerRequest" && row.path?.startsWith("/v1/individual_appointments")), false);
        const review = call.mutations.filter(row => row.path === "/v1/recalls"); assert.equal(review.length, 1);
        assert.equal(resultValue(decodeClinikoReview(review[0]!.body?.notes)).request.operation.kind, operation === "book" ? "classBook" : "classCancel");
        if (operation === "cancel") assert.equal(writes[0]!.body?.apply_to_repeats, false);
        if (lost) {
          assert.match(call.spoken.at(-1)!, /can't confirm|couldn't confirm|not confirmed|unconfirmed/i);
          await call.mark(); await call.say("What happened?");
          assert.match(call.spoken.at(-1)!, /can't confirm|couldn't confirm|not confirmed|unconfirmed/i);
          assert.equal(attendances(call).length, 1); assert.equal(call.mutations.filter(row => row.path === "/v1/recalls").length, 1);
        } else {
          const rows = await call.db.selectFrom("cliniko_request_budgets").select(["sent_at_ms", "max_per_minute"]).execute();
          const requestKind = (path: string) => path.startsWith("/v1/patients/") ? "patient" : path.startsWith("/v1/attendees/") ? "ownAttendance" : path === "/v1/attendees" ? "capacity" : path.startsWith("/v1/group_appointments") ? "class" : "metadata";
          const diagnostic = {
            budget: rows.map(row => ({ used: Array.isArray(row.sent_at_ms) ? row.sent_at_ms.length : -1, limit: row.max_per_minute })),
            write: call.messages.filter(row => row.kind === "classWriteOutcome").map(row => ({ status: row.actionStatus, elapsedMs: row.elapsedMs })),
            lastReads: call.messages.filter(row => row.kind === "providerRequest").slice(-8).map(row => ({ kind: requestKind(row.path!), elapsedMs: row.elapsedMs })),
          };
          if (process.env.ABBY_CLASS_DIAGNOSTICS === "1") process.stdout.write(`${JSON.stringify({ operation, ...diagnostic })}\n`);
          assert.equal(call.spoken.at(-1)!, operation === "book" ? "Your booking is confirmed." : "Your appointment cancellation is confirmed.", JSON.stringify(diagnostic));
          assert.equal(call.messages.filter(row => row.kind === "classWriteOutcome").at(-1)!.actionStatus, "committed");
        }
        assert.ok(call.messages.some(row => row.kind === "classPermissionDecision" && row.allowed === true));
        const code = call.messages.find(row => row.kind === "verificationEmail")!.code!;
        for (const secret of [code, ...verificationCanaries]) assert.equal(JSON.stringify([call.spoken, call.messages.filter(row => row.kind === "modelTurn" || row.kind === "ordinaryFinal")]).includes(secret), false);
        await call.scan([code, ...verificationCanaries]);
      }, { classes: true });
    });

  for (const operation of ["book", "cancel"] as const) for (const fault of ["denyPermission", "denyClassPermission", "revokeClass", "changePolicy"] as const)
    test(`E2E-395 compiled class ${operation} ${fault} after played consent denies native mutation and false success`, options, async () => {
      await withClinicalRunner(operation, async call => {
        await prepare(call, operation); await call.mark(); call.child.send({ kind: fault });
        if (fault === "revokeClass") await voiceUntil(() => call.messages.some(row => row.kind === "classRevoked"), "current class approval revocation");
        await call.say("Yes");
        assert.equal(call.mutations.length, 0); assert.equal(call.spoken.at(-1)!.includes("is confirmed"), false);
        await call.scan(verificationCanaries);
      }, { classes: true });
    });

  for (const fault of ["denyPermission", "loseMail"] as const)
    test(`E2E-395 compiled class ${fault} cannot issue private patient authority`, options, async () => {
      await withClinicalRunner("book", async call => {
        call.child.send({ kind: fault }); await call.say("Start"); await call.mark();
        if (fault === "denyPermission") {
          await voiceUntil(() => call.messages.some(row => row.kind === "permissionDecision" && row.allowed === false), "class caller authority denial");
          assert.equal(call.messages.some(row => row.kind === "verificationEmail"), false);
        } else {
          await voiceUntil(() => call.messages.some(row => row.kind === "verificationEmail" && row.accepted === false), "class code delivery failure");
          await call.verify(false);
        }
        assert.equal(call.mutations.length, 0); await call.scan(verificationCanaries);
      }, { classes: true });
    });

  for (const afterWrite of [false, true])
    test(`E2E-395 compiled class capacity ${afterWrite ? "race after write" : "lost before write"} cannot become a confirmed booking`, options, async () => {
      await withClinicalRunner("book", async call => {
        await prepare(call, "book"); await call.mark(); call.child.send({ kind: afterWrite ? "overbookAfterWrite" : "fillClass" });
        await voiceUntil(() => call.messages.some(row => row.kind === (afterWrite ? "classRaceArmed" : "classOccupied")), "native class capacity change");
        await call.say("Yes");
        assert.equal(attendances(call).length, afterWrite ? 1 : 0);
        assert.equal(call.mutations.filter(row => row.path === "/v1/recalls").length, afterWrite ? 1 : 0);
        assert.equal(call.spoken.at(-1)!.includes("is confirmed"), false);
        if (afterWrite) {
          assert.match(call.spoken.at(-1)!, /can't confirm|couldn't confirm|not confirmed|unconfirmed/i);
          await call.mark(); await call.say("What happened?"); assert.equal(attendances(call).length, 1);
        }
        await call.scan(verificationCanaries);
      }, { classes: true });
    });
});
