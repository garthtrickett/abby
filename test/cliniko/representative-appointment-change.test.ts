import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { ClinikoVerificationContactReader } from "../../src/cliniko/verification-contact.ts";
import { ClinikoAppointmentChangeGuard } from "../../src/standalone/cliniko-appointment-change-guard.ts";
import { ClinikoCancellationWriter } from "../../src/cliniko/cancellation-write.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { CallerVerificationSession } from "../../src/standalone/caller-verification-session.ts";
import { ClinikoCancellationSession } from "../../src/standalone/cliniko-cancellation-session.ts";
import { ClinikoReschedulingSession } from "../../src/standalone/cliniko-rescheduling-session.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { cancellationSessionFixture } from "../support/cancellation-session.ts";
import { reschedulingSessionFixture } from "../support/rescheduling-session.ts";
import { representativeFixture } from "../support/representative-selection.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";

for (const operation of ["appointments.cancel", "appointments.reschedule"] as const) {
  test(`E2E-383 related-person ${operation} targets only the separately verified patient's native appointment`, async context => {
    const nativeBudget = new ClinikoReadBudget(200, () => Date.parse(verificationNow));
    const claimStats = { allowed: 0, denied: 0 };
    let phase = "setup"; const claimsByPhase: Record<string, number> = {};
    const rootPaths: Record<string, number> = {}, workflowPaths: Record<string, number> = {};
    const budget = { claim: () => { const result = nativeBudget.claim(); claimsByPhase[phase] = (claimsByPhase[phase] ?? 0) + 1; result ? claimStats.denied++ : claimStats.allowed++; return result; }, observe429: (header: string | null) => nativeBudget.observe429(header) };
    const f = operation === "appointments.cancel" ? await cancellationSessionFixture({ rateBudget: budget }) : await reschedulingSessionFixture({ rateBudget: budget });
    const rootMail: { email: string; code: string }[] = [];
    const root = resultValue(CallerVerificationSession.create({ ...f.sessionConfig, contact: new ClinikoVerificationContactReader({ ...f.config.cliniko, scope: f.scope }, async (...args) => { const path = new URL(String(args[0])).pathname; rootPaths[path] = (rootPaths[path] ?? 0) + 1; return f.config.fetchPort!(...args); }), delivery: { send: async (email, code) => { rootMail.push({ email, code }); return true; } } }));
    const actorStats = { inFlight: 0, maximum: 0, failures: [] as { ms: number; aborted: boolean }[] };
    const rootSubject = root.verifiedSubject.bind(root);
    root.verifiedSubject = async (...args: Parameters<typeof rootSubject>) => {
      actorStats.maximum = Math.max(actorStats.maximum, ++actorStats.inFlight); const at = Date.now();
      try { const result = await rootSubject(...args); if (!result) actorStats.failures.push({ ms: Date.now() - at, aborted: args[1]?.aborted ?? false }); return result; }
      finally { actorStats.inFlight--; }
    };
    const actor = { ...f, session: root, mail: rootMail, config: { path: f.config.callerApprovalPath, scope: f.scope, policyVersion: f.sessionConfig.policyVersion,
      operation, directory: f.config.directory, clock: f.sessionConfig.clock } };
    const r = await representativeFixture(f.config.cliniko.rateBudget, { fixture: actor, operation });
    let owner: ClinikoCancellationSession | ClinikoReschedulingSession | undefined;
    const base = "https://api.au5.cliniko.com/v1";
    const appointment = (id: string, patient: string) => ({ id, starts_at: "2026-10-08T04:00:00.000Z", ends_at: "2026-10-08T04:30:00.000Z", cancelled_at: null as string | null,
      archived_at: null, deleted_at: null, notes: "synthetic change target", patient: { links: { self: `${base}/patients/${patient}` } },
      business: { links: { self: `${base}/businesses/11` } }, practitioner: { links: { self: `${base}/practitioners/22` } }, appointment_type: { links: { self: `${base}/appointment_types/33` } } });
    const selected = appointment("91", "43"), parent = appointment("92", verificationCanaries[2]!);
    const originalParent = structuredClone(parent), reviews: Record<string, unknown>[] = [];
    let patches = 0, permissions = true;
    const outcomes: unknown[] = [];
    const resolveOriginal = ClinikoAppointmentChangeGuard.prototype.resolve;
    context.mock.method(ClinikoAppointmentChangeGuard.prototype, "resolve", async function(this: ClinikoAppointmentChangeGuard, ...args: Parameters<typeof resolveOriginal>) {
      const result = await resolveOriginal.apply(this, args);
      if (!result.ok) outcomes.push({ phase: args[1], error: result.error }); return result;
    });
    if (operation === "appointments.cancel") {
      const original = ClinikoCancellationWriter.prototype.cancelOnce;
      context.mock.method(ClinikoCancellationWriter.prototype, "cancelOnce", async function(this: ClinikoCancellationWriter, ...args: Parameters<typeof original>) {
        const result = await original.apply(this, args); outcomes.push(result); return result;
      });
    }
    const providerErrors: string[] = [];
    const fetchPort: typeof fetch = async (value, init) => {
      const url = new URL(String(value)), method = init?.method ?? "GET";
      if (url.pathname === "/v1/patients/43") return Response.json(r.patients.get("43"));
      if (url.pathname === "/v1/recalls") {
        if (method === "GET") return Response.json({ total_entries: reviews.length, recalls: reviews });
        assert.equal(method, "POST"); const body = JSON.parse(String(init?.body)); assert.equal(body.patient_id, "43");
        const row = { id: "71", archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes,
          patient: selected.patient, recall_type: { links: { self: `${base}/recall_types/7` } } };
        reviews.push(row); return Response.json(row, { status: 201 });
      }
      if (url.pathname === "/v1/individual_appointments") {
        assert.ok(url.searchParams.getAll("q[]").some(query => query === "patient_id:=43"));
        return Response.json({ total_entries: 1, individual_appointments: [selected] });
      }
      if (url.pathname.endsWith("/conflicts")) return Response.json({ conflicts: { exist: false } });
      if (url.pathname === "/v1/individual_appointments/91" || url.pathname === "/v1/individual_appointments/91/cancel") {
        if (method === "PATCH") {
          assert.equal(reviews.length, 1); const state = await f.state(), action = Object.values(state.actions)[0]!;
          assert.equal(action.status, "dispatched"); assert.equal(state.presentations[action.presentationId]?.status, "played");
          patches++; const body = JSON.parse(String(init?.body));
          if (operation === "appointments.cancel") { assert.equal(body.cancellation_reason, 50); selected.cancelled_at = verificationNow; return new Response(null, { status: 204 }); }
          assert.deepEqual(body, { starts_at: "2026-10-08T05:00:00.000Z", ends_at: null });
          selected.starts_at = body.starts_at; selected.ends_at = "2026-10-08T05:30:00.000Z";
        }
        return Response.json(selected);
      }
      return f.config.fetchPort!(value, init);
    };
    try {
      phase = "actor"; await r.verifyActor(); phase = "select-person"; const choice = resultValue(await r.select());
      const checkedFetch: typeof fetch = async (...args) => {
        try { const path = new URL(String(args[0])).pathname; workflowPaths[path] = (workflowPaths[path] ?? 0) + 1; return await fetchPort(...args); } catch (error) { providerErrors.push(error instanceof Error ? error.message : "provider failed"); throw error; }
      };
      const common = { ...f.config, callerApprovalPath: r.config.representativeCallerApprovalPath,
        representative: { owner: r.owner, selectionRef: choice.selectionRef }, fetchPort: checkedFetch, signal: r.lifetime.signal, delivery: r.config.delivery,
        permission: { allows: async (_scope: unknown, patientId: string) => patientId === "43" && permissions } };
      phase = "construct"; owner = operation === "appointments.cancel" ? resultValue(await ClinikoCancellationSession.create(common as Parameters<typeof ClinikoCancellationSession.create>[0]))
        : resultValue(await ClinikoReschedulingSession.create(common as Parameters<typeof ClinikoReschedulingSession.create>[0]));
      phase = "subject-code"; owner.beginVerification(); const deadline = Date.now() + 5000;
      while (!r.mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
      assert.equal(r.mail[0]?.email, "subject-one-private@example.test"); assert.equal((await owner.submitCode(r.mail[0]!.code)).verified, true);
      phase = "subject-grant"; const grant = await owner.verified(); assert.ok(grant);
      const reception = new TextReception(f.ledger, f.policies, owner.effects, undefined, owner instanceof ClinikoCancellationSession ? owner.appointments : undefined);
      const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.scope }, f.policies, reception, undefined, undefined, undefined, f.ledger);
      const turn = (id: string, text = "Change the selected appointment") => ({ callId: f.callId, sessionId: f.sessionId, turnId: id, text, quality: "clear" as const, at: verificationNow });
      async function play() { const pending = (await f.state()).pendingPresentationId!; assert.ok(pending);
        resultValue(await f.runtime.startPresentation(f.callId, pending, f.sessionId, verificationNow));
        resultValue(await f.runtime.resolvePresentation(f.callId, pending, "played", f.sessionId, verificationNow)); }
      if ((await f.state()).pendingPresentationId) await play();
      if (owner instanceof ClinikoCancellationSession) {
        resultValue(await agent.submit({ kind: "appointments.read.v1", turn: turn("menu"), verificationRef: grant.verificationRef, from: verificationNow, to: "2026-10-09T06:00:00.000Z", now: verificationNow }));
        await play(); resultValue(await agent.submit({ kind: "appointments.change.propose.v1", turn: turn("propose"),
          selection: { kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" }, now: verificationNow }));
      } else {
        for (const stage of ["targets", "offers"] as const) {
          phase = `read-${stage}`; resultValue(await agent.submit({ kind: "rescheduling.menu.read.v1", turn: turn(`menu-${stage}`), stage,
            from: stage === "targets" ? verificationNow : "2026-10-08", to: stage === "targets" ? "2026-10-09T06:00:00.000Z" : "2026-10-08", now: verificationNow }));
          assert.match((await f.state()).callerMessages.at(-1)!, /Option one/i, `menu ${stage}: ${(await f.state()).callerMessages.at(-1)}`);
          await play(); phase = `select-${stage}`; resultValue(await agent.submit({ kind: "rescheduling.menu.select.v1", turn: turn(`select-${stage}`), stage, choice: 1, now: verificationNow }));
          assert.ok(!(await f.state()).callerMessages.at(-1)?.includes("can't"), `selection ${stage}: ${(await f.state()).callerMessages.at(-1)}; actor: ${JSON.stringify({ ...actorStats, claimStats, providerReads: f.provider.length })}; providers: ${providerErrors.join(",")}`);
          if (stage === "targets") await play();
        }
      }
      const action = Object.values((await f.state()).actions)[0]!; assert.ok(action, (await f.state()).callerMessages.at(-1)); assert.equal(patches, 0);
      await play(); phase = "affirm"; resultValue(await reception.affirm(f.scope, turn("affirm", "Yes"), action.key, action.digest, verificationNow));
      phase = "drain"; resultValue(await reception.drain(f.scope, f.callId, verificationNow)); assert.deepEqual(providerErrors, []); assert.equal((await f.state()).actions[action.key]!.status, "committed", JSON.stringify({ patches, cancelled: selected.cancelled_at !== null, outcomes, actorStats, claimStats, claimsByPhase, rootPaths, workflowPaths, selectionPaths: r.requests.reduce<Record<string, number>>((counts, path) => { const name = path.split("?")[0]!; counts[name] = (counts[name] ?? 0) + 1; return counts; }, {}), providerReads: f.provider.length, actor: !!await root.verified(), subject: !!await owner.verified() }));
      assert.equal(patches, 1); assert.deepEqual(parent, originalParent); assert.equal(reviews.length, 1);
      permissions = false; assert.equal(await owner.verified(), undefined); assert.ok(await root.verified());
    } finally { owner?.dispose(); root.dispose(); await r.close(); }
  });
}
