import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ClinicPolicyRouter } from "../../src/reference/clinic-number-routing.ts";
import { ClinikoLocationServiceDirectory } from "../../src/standalone/cliniko-location-service-directory.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { SharedNumberIntakeService } from "../../src/voice/shared-number-intake.ts";
import { PrelocationVoiceSession } from "../../src/voice/prelocation-voice-session.ts";
import { locationServiceFixture } from "../support/location-service-catalogue.ts";
import { withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

for (const mode of ["revision", "revocation", "unplayed", "definiteFailure", "uncertain"] as const) test(`E2E-352 prelocation service information fences ${mode}`, async () => {
  const f = await locationServiceFixture();
  try {
    const now = verificationNow, event = { ...f.north.inbound, key: { accountRef: "synthetic-account", providerCallRef: `discovery-${mode}` }, receivedAt: now };
    const ledger = new MemoryLedger(), directory = new ClinikoLocationServiceDirectory(f.routingHost(event.key.accountRef), f.sources);
    const router = new ClinicPolicyRouter(directory, withApprovedSyntheticVoice(f.north.policies));
    const admission = new CallAdmissionService(ledger, router.resolve, () => now, async () => ({ ok: true, value: true }));
    const intake = new SharedNumberIntakeService(ledger, router, admission, () => now);
    const queued: { id: string; text: string }[] = [];
    let send: "queued" | "notSent" | "uncertain" = "queued";
    const session = new PrelocationVoiceSession(event, "prelocation", ledger, intake, {
      enqueue: async (id, text) => { queued.push({ id, text }); return send; }, clear: async () => true,
    });
    resultValue(await intake.begin(event)); resultValue(await session.attach());
    const prompt = resultValue(await session.dispatchPrompt(now)); resultValue(await session.acceptPlaybackResult(prompt.playbackId, "played", now));
    const turn = async (text: string) => {
      const generation = resultValue(await session.speechStarted(now));
      resultValue(session.acceptTranscript({ kind: "segmentFinal", sessionId: "prelocation", generation, utteranceId: `turn-${generation}`, text, quality: "clear" }));
      return session.finishTurn(now);
    };
    assert.equal(resultValue(await turn("Where can I book Massage?")).kind, "locationInformation");
    if (mode === "definiteFailure") send = "notSent";
    if (mode === "uncertain") send = "uncertain";
    const reply = resultValue(await session.dispatchPrompt(now)); assert.match(queued.at(-1)!.text, /North lists Massage/);
    assert.equal(resultValue(await ledger.findAdmission(callIdFor(event.key))), null);
    if (mode === "definiteFailure") {
      send = "queued"; const retry = resultValue(await session.dispatchPrompt(now));
      assert.equal(queued.at(-1)!.text, queued.at(-2)!.text); assert.notEqual(retry.playbackId, reply.playbackId);
      resultValue(await session.acceptPlaybackResult(retry.playbackId, "played", now));
      const bound = resultValue(await turn("North")); assert.ok("receipt" in bound); assert.deepEqual(bound.receipt.scope, f.north.scope);
    } else if (mode === "uncertain") {
      const count = queued.length; assert.equal(resultValue(await session.dispatchPrompt(now)).playbackId, reply.playbackId); assert.equal(queued.length, count);
    } else {
      if (mode !== "unplayed") resultValue(await session.acceptPlaybackResult(reply.playbackId, "played", now));
      if (mode === "revision") await f.south.replaceServices({ revision: "changed-after-information" });
      if (mode === "revocation") await f.south.replaceServices({ enabled: false });
      assert.equal((await turn("North")).ok, false); assert.equal(resultValue(await ledger.findAdmission(callIdFor(event.key))), null);
    }
    assert.equal(f.north.mail.length + f.south.mail.length, 0); assert.equal(f.north.allTraffic.length + f.south.allTraffic.length, 0);
  } finally { await f.close(); }
});
