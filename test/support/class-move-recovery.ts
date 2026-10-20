import assert from "node:assert/strict";
import { ClinikoClassMoveRecovery } from "../../src/standalone/cliniko-class-move-recovery.ts";
import type { HostActor } from "../../src/reference/command-gateway.ts";
import { classMoveFixture } from "./class-move.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

export async function classMoveRecoveryFixture(pass: boolean, finish: "moved" | "restored" | "partial" = "moved", cross = false, lost?: "original" | "association") {
  const f = await classMoveFixture(cross, false, pass ? cross ? { differentCase: true } : {} : undefined, true);
  try {
    if (lost) f.lose(lost);
    await f.verify(); const initial = await f.prepare(); await f.play(); await f.pause(61);
    resultValue(await f.reception.affirm(f.scope, f.turn("initial-yes", "Yes"), initial.key, initial.digest, f.config.clock()));
    resultValue(await f.reception.drain(f.scope, f.callId, f.config.clock()));
    if (finish === "restored") f.phasePermission(phase => phase !== "cancelOriginal");
    for (let phase = 0; finish !== "partial" && phase < 6; phase++) {
      const action = (await f.state()).actions[initial.key]!;
      if (action.status !== "pendingContinuation") break;
      await f.play(); await f.pause(61);
      const codes = f.mail.length;
      let prepared = resultValue(await f.host.prepareClassMovementContinuation(initial.key, new AbortController().signal));
      if (prepared.kind === "verificationRequired") {
        const until = Date.now() + 5000;
        while (f.mail.length <= codes && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2));
        assert.ok(f.mail.length >= 2);
        assert.deepEqual(await f.host.submitClassMovementCode(f.mail.at(-1)!.code, new AbortController().signal), { verified: true });
        await f.pause(61); prepared = resultValue(await f.host.prepareClassMovementContinuation(initial.key, new AbortController().signal));
      }
      assert.equal(prepared.kind, "ready"); if (prepared.kind !== "ready") throw new Error("phase unavailable");
      resultValue(await f.runtime.prepareClassMovementConsent(f.callId, initial.key, prepared.evidence, f.config.clock(), prepared.expectedConversationRevision));
      await f.play();
      resultValue(await f.runtime.acceptTurn(f.turn("phase-yes", "Yes"),
        { kind: "classMovementAffirm", actionKey: initial.key, digest: (await f.state()).actions[initial.key]!.classMovementConsent!.digest }, f.config.clock()));
      resultValue(await f.reception.drain(f.scope, f.callId, f.config.clock()));
    }
    assert.equal((await f.state()).actions[initial.key]!.classMovement?.outcome, lost ? "needsReview" : finish === "partial" ? "pending" : finish);
    const c = f.config;
    // End the caller and discard both live owner and proof. Cold staff permission is independent.
    resultValue(await f.runtime.endCall(f.callId, f.sessionId, f.config.clock())); f.host.dispose(); f.session.dispose();
    let actor: HostActor | null = structuredClone(f.account.actor), permitted = true;
    const traffic: string[] = [];
    let beforeRead: ((path: string) => void | Promise<void>) | undefined;
    const recovery = new ClinikoClassMoveRecovery({ scope: f.scope, cliniko: c.cliniko,
      sourcePolicy: c.sourcePolicy, destinationPolicy: c.destinationPolicy, movePolicy: c.movePolicy,
      directory: f.classSessionConfig.directory, authority: { currentActor: async () => actor,
        permitsReviewedResolution: async () => permitted }, clock: c.clock,
      ...(c.classPassMoveAuthority ? { classPassMoveAuthority: c.classPassMoveAuthority } : {}),
      fetchPort: async (input, init) => { assert.equal(init?.method ?? "GET", "GET");
        const path = new URL(String(input)).pathname; traffic.push(path); await beforeRead?.(path); return c.fetchPort(input, init); } });
    return { f, recovery, traffic, initial, request: { recallRef: "cliniko:recall:71" },
      acknowledge() { f.recalls[0]!.recalled = true; }, deny() { permitted = false; },
      setActor(value: HostActor | null) { actor = value; }, beforeRead(hook: (path: string) => void | Promise<void>) { beforeRead = hook; },
      elapse() { f.setTime(new Date(Date.parse(f.config.clock()) + 61000).toISOString()); },
      close: () => f.close() };
  } catch (error) { await f.close(); throw error; }
}

