import assert from "node:assert/strict";
import test from "node:test";
import { TextReception } from "../../src/reference/text-reception.ts";
import { DisabledStandaloneHost } from "../../src/standalone/disabled-host.ts";
import { publicInformationUnavailable } from "../../src/core/public-information.ts";
import { publicServiceInformationFixture, publicServices } from "../support/public-service-information.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { CallRuntime } from "../../src/core/runtime.ts";

test("E2E-322 held public service reads with expired approval or interrupted consumer cannot present stale descriptions", { timeout: 30_000 }, async () => {
  const run = async (mode: "expired" | "aborted" | "revision") => {
    const f = await publicServiceInformationFixture();
    let release: () => void = () => undefined, entered: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { entered = resolve; });
    let pending: ReturnType<TextReception["answer"]> | undefined, hostRead: Promise<unknown> | undefined;
    try {
      if (mode === "expired") await f.replaceFAQs({ effectiveUntil: "2026-10-04T06:00:00.500Z" });
      const original = f.knowledge.readKnowledge.bind(f.knowledge);
      f.knowledge.readKnowledge = (...args) => {
        const read = (async () => { const value = await original(...args); assert.equal(value.ok, true); entered(); await gate; return value; })();
        hostRead = read; return read;
      };
      const reception = new TextReception(f.ledger, f.policies, new DisabledStandaloneHost(), undefined, undefined, undefined, f.knowledge, f.flowConfig.clock);
      const before = await f.state(), lifetime = new AbortController(), turn = f.turn(`public-${mode}`, "Which appointment type do I need?");
      pending = reception.answer(f.scope, turn, ["clinic-public-serviceGuidance"], publicServices, turn.at, before.conversationRevision, lifetime.signal);
      await held;
      if (mode === "aborted") lifetime.abort();
      if (mode === "revision") resultValue(await new CallRuntime(f.ledger, f.scope).nonAffirmativeFinal(f.turn("superseding-public-question", "Wait, stop."), before.conversationRevision, turn.at));
      if (mode === "expired") f.setTime("2026-10-04T06:00:01.000Z");
      release(); const answer = await pending;
      if (mode === "expired") assert.equal(resultValue(answer).callerMessages.at(-1), publicInformationUnavailable("serviceGuidance"));
      else { assert.equal(answer.ok, false); assert.deepEqual((await f.state()).callerMessages, before.callerMessages); }
      assert.deepEqual((await f.state()).actions, before.actions); assert.deepEqual((await f.state()).staffItems, before.staffItems); assert.equal(f.mail.length, 0); assert.equal(f.posts, 0);
    } finally { release(); await Promise.allSettled([pending, hostRead]); await f.close(); }
  };
  const settled = await Promise.allSettled([run("expired"), run("aborted"), run("revision")]);
  for (const result of settled) if (result.status === "rejected") throw result.reason;
});
