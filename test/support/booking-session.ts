import assert from "node:assert/strict";
import { join } from "node:path";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ClinikoBookingSession } from "../../src/standalone/cliniko-booking-session.ts";
import type { ClinikoBookingSessionConfig } from "../../src/standalone/cliniko-booking-session.ts";
import { bookingOffersFixture } from "./booking-offers.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { verificationNow } from "./caller-verification.ts";

/** Actual admitted-call composition and caller commands; clinic approval/permission/mail/provider are synthetic. */
export async function bookingSessionFixture(options: Parameters<typeof bookingOffersFixture>[0] = {}) {
  const f = await bookingOffersFixture(options);
  f.host.dispose(); f.source.dispose(); f.session.dispose();
  const lifetime = new AbortController(); let owner: ClinikoBookingSession | undefined;
  try {
    const config: ClinikoBookingSessionConfig = { receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId,
      policyVersion: f.sessionConfig.policyVersion, ledger: f.ledger, policies: f.policies, lookup: f.sessionConfig.lookup,
      permission: f.sessionConfig.permission, verificationBudget: options.verificationBudget ?? { reserve: async () => true },
      delivery: { send: async (email, code) => { f.mail.push({ email, code }); return true; } },
      directory: f.directory, callerApprovalPath: join(f.folder, "approval.json"), bookingApprovalPath: f.path,
      cliniko: { apiKey: "synthetic-session-au5", contactEmail: "test@example.test", businessId: "11", practitionerId: "22", appointmentTypeId: "33",
        recallTypeId: "7", timeZone: "Australia/Sydney", countryCallingCode: "61", rateBudget: f.ownerPorts.rateBudget },
      signal: lifetime.signal, fetchPort: f.ownerPorts.fetchPort, clock: f.sessionConfig.clock,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) };
    owner = resultValue(await ClinikoBookingSession.create(config));
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
      readMenu: (turnId = "menu") => agent.submit({ kind: "booking.offers.read.v1", turn: f.turn(turnId, "What times can I book?"), from: "2026-10-08", to: "2026-10-08", now: verificationNow }),
      select: (choice: 1|2|3 = 1, turnId = "select") => agent.submit({ kind: "booking.offers.select.v1", turn: f.turn(turnId, "Option one"), choice, now: verificationNow }),
      get posts() { return f.posts; }, get claims() { return f.claims; }, drain: () => reception.drain(f.scope, f.callId, verificationNow),
      close: async () => { lifetime.abort(); owner?.dispose(); await f.close(); } };
  } catch (error) { lifetime.abort(); owner?.dispose(); await f.close(); throw error; }
}
