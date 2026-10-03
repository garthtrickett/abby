import assert from "node:assert/strict";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import { proposalCanaries, proposalHarness, proposalNow, resultValue } from "../support/agent-appointment-proposals.ts";
import type { ProposalOperation } from "../support/agent-appointment-proposals.ts";

for (const operation of ["cancel", "reschedule", "intake"] as readonly ProposalOperation[]) {
  for (const mode of ["standalone", "embedded"] as const) {
    test(`E2E-261 ${mode} voice session speaks an agent ${operation} proposal and preserves caller confirmation`, async () => {
      const app = proposalHarness({ tenantId: `voice-agent-${mode}-${operation}`, clinicId: "clinic", locationId: "main" }, mode);
      await app.enable();
      const command = await app.admit(operation, "voice", false);
      const spoken: string[] = [];
      const voice = new VoiceSession(command.turn.callId, command.turn.sessionId, app.scope, app.ledger, app.reception,
        { async enqueue(_playbackId, text) { spoken.push(text); return "queued"; }, async clear() { return true; } },
        async () => ok({ kind: "affirm" as const }));
      async function playPending(): Promise<void> {
        const queued = resultValue(await voice.dispatchPending(proposalNow));
        assert.equal(queued.kind, "queued");
        if (queued.kind !== "queued") assert.fail("expected audible presentation");
        assert.ok(queued.playbackId);
        resultValue(await voice.acceptPlaybackResult(queued.playbackId, "played", proposalNow));
      }
      try {
        resultValue(await voice.attach(proposalNow));
        await playPending();
        assert.equal(spoken[0], "Hello. How can I help you?");
        const proposal = resultValue(await app.agent.submit(command));
        assert.ok("progress" in proposal);
        assert.equal(app.host.writes.length, 0);
        if (mode === "standalone") {
          assert.deepEqual(proposal.progress.actions, []);
          await playPending();
          assert.match(spoken.at(-1)!, /can't|cannot|contact/i);
          assert.equal(app.host.evidenceReads, 0);
          assert.equal(app.host.writes.length, 0);
          return;
        }
        assert.equal(proposal.progress.actions[0]?.status, "awaitingConfirmation");
        const detail = resultValue(await voice.dispatchPending(proposalNow));
        assert.equal(detail.kind, "queued");
        if (detail.kind !== "queued") assert.fail("expected proposed details");
        assert.ok(detail.playbackId);
        assert.equal(app.host.writes.length, 0);
        if (operation !== "intake") assert.match(spoken.at(-1)!, /No fee applies/);
        resultValue(await voice.acceptPlaybackResult(detail.playbackId, "played", proposalNow));
        assert.equal(app.host.writes.length, 0);
        const generation = resultValue(await voice.speechStarted(proposalNow));
        resultValue(voice.acceptTranscript({ kind: "segmentFinal", sessionId: command.turn.sessionId, generation,
          utteranceId: "caller-confirmation", text: "Yes", quality: "clear" }));
        const affirmed = resultValue(await voice.finishTurn(proposalNow));
        const action = Object.values(affirmed.actions)[0]!;
        assert.equal(action.status, "ready");
        assert.equal(app.host.writes.length, 0);
        const completed = resultValue(await voice.drainVoiceEffects(proposalNow));
        assert.equal(completed.actions[action.key]?.status, "committed");
        assert.equal(app.host.writes.length, 1);
        await playPending();
        assert.match(spoken.at(-1)!, /confirmed|saved/i);
        for (const canary of proposalCanaries.filter(value => value !== "private-agent-caller-text")) {
          assert.equal(spoken.join(" ").includes(canary), false);
        }
        resultValue(await app.agent.submit(command));
        resultValue(await voice.drainVoiceEffects(proposalNow));
        assert.equal(app.host.writes.length, 1);
      } finally {
        resultValue(await voice.end(proposalNow));
        const ended = resultValue(await app.runtime.read(command.turn.callId));
        assert.equal(ended.lifecycle, "ended");
      }
    });
  }
}
