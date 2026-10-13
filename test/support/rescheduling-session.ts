import assert from "node:assert/strict";
import { join } from "node:path";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ClinikoReschedulingSession } from "../../src/standalone/cliniko-rescheduling-session.ts";
import type { ClinikoReschedulingSessionConfig } from "../../src/standalone/cliniko-rescheduling-session.ts";
import { reschedulingAuthorityFixture } from "./rescheduling-authority.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { verificationNow } from "./caller-verification.ts";

/** Actual admitted-call composition and caller commands; clinic approval/permission/mail/provider are synthetic. */
export async function reschedulingSessionFixture(options: Parameters<typeof reschedulingAuthorityFixture>[0] = {}) {
  const f = await reschedulingAuthorityFixture(options);
  f.host.dispose(); f.source.dispose(); f.session.dispose();
  const lifetime = new AbortController(); let owner: ClinikoReschedulingSession | undefined;
  try {
    const config: ClinikoReschedulingSessionConfig = { receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId,
      policyVersion: f.sessionConfig.policyVersion, ledger: f.ledger, policies: f.policies, lookup: f.sessionConfig.lookup,
      permission: f.sessionConfig.permission, verificationBudget: options.verificationBudget ?? { reserve: async () => true },
      delivery: { send: async (email, code) => { f.mail.push({ email, code }); return true; } },
      directory: f.directory, callerApprovalPath: join(f.folder, "approval.json"), bookingApprovalPath: f.destinationPath, reschedulingApprovalPath: f.path,
      ...(options.destinationPractitionerId ? { destination: { practitionerId: options.destinationPractitionerId, bookingApprovalPath: f.destinationPath } } : {}),
      cliniko: { apiKey: "synthetic-session-au5", contactEmail: "test@example.test", businessId: "11", practitionerId: "22", appointmentTypeId: "33",
        recallTypeId: "7", timeZone: "Australia/Sydney", countryCallingCode: "61", rateBudget: f.ownerPorts.rateBudget },
      signal: lifetime.signal, fetchPort: f.ownerPorts.fetchPort, clock: f.sessionConfig.clock,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) };
    owner = resultValue(await ClinikoReschedulingSession.create(config));
    const reception = new TextReception(f.ledger, f.policies, owner.effects);
    const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.scope }, f.policies, reception, undefined, undefined, undefined, f.ledger);
    async function verify() {
      owner!.beginVerification(); const deadline = Date.now()+5000;
      while (!f.mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
      assert.ok(f.mail[0]); assert.equal((await owner!.submitCode(f.mail[0].code)).verified, true);
      const grant = await owner!.verified(); assert.ok(grant); return grant.verificationRef;
    }
    async function playPending() {
      const presentation = (await f.state()).pendingPresentationId!; assert.ok(presentation);
      resultValue(await f.runtime.startPresentation(f.callId, presentation, f.sessionId, verificationNow));
      resultValue(await f.runtime.resolvePresentation(f.callId, presentation, "played", f.sessionId, verificationNow));
    }
    async function confirm() {
      await playPending(); const action = Object.values((await f.state()).actions)[0]!;
      return reception.affirm(f.scope, f.turn("affirm", "Yes"), action.key, action.digest, verificationNow);
    }
    if ((await f.state()).pendingPresentationId) await playPending(); // Rehearse the actual initial greeting receipt.
    return { ...f, owner, config, lifetime, reception, agent, verify, playPending, confirm,
      readMenu: (stage: "targets" | "offers", turnId = `menu-${stage}`) => agent.submit({ kind: "rescheduling.menu.read.v1", turn: f.turn(turnId, "What appointments or times can I move?"), stage,
        from: stage === "targets" ? verificationNow : "2026-10-08", to: stage === "targets" ? "2026-10-09T06:00:00.000Z" : "2026-10-08", now: verificationNow }),
      selectMenu: (stage: "targets" | "offers", choice: 1|2|3 = 1, turnId = `select-${stage}`) => agent.submit({ kind: "rescheduling.menu.select.v1", turn: f.turn(turnId, "Option one"), stage, choice, now: verificationNow }),
      get patches() { return f.patches; }, get claims() { return f.claims; }, drain: () => reception.drain(f.scope, f.callId, verificationNow),
      proposalJourney: async () => {
        assert.ok((await agent.submit({ kind: "rescheduling.menu.read.v1", turn: f.turn("menu-targets"), stage: "targets", from: verificationNow, to: "2026-10-09T06:00:00.000Z", now: verificationNow })).ok);
        await playPending(); assert.ok((await agent.submit({ kind: "rescheduling.menu.select.v1", turn: f.turn("select-targets"), stage: "targets", choice: 1, now: verificationNow })).ok);
        await playPending(); assert.ok((await agent.submit({ kind: "rescheduling.menu.read.v1", turn: f.turn("menu-offers"), stage: "offers", from: "2026-10-08", to: "2026-10-08", now: verificationNow })).ok);
        await playPending(); assert.ok((await agent.submit({ kind: "rescheduling.menu.select.v1", turn: f.turn("select-offers"), stage: "offers", choice: 1, now: verificationNow })).ok);
      },
      close: async () => { lifetime.abort(); owner?.dispose(); await f.close(); } };
  } catch (error) { lifetime.abort(); owner?.dispose(); await f.close(); throw error; }
}
