import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoCancellationSession } from "../../src/standalone/cliniko-cancellation-session.ts";
import { verificationPrompt } from "../../src/standalone/caller-verification-session.ts";
import { cancellationSessionFixture } from "../support/cancellation-session.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
  assert.ok(predicate());
}
async function verify(f: Awaited<ReturnType<typeof cancellationSessionFixture>>) {
  assert.deepEqual(f.owner.beginVerification(), { prompt: verificationPrompt });
  await waitUntil(() => f.mail.length === 1);
  assert.deepEqual(await f.owner.submitCode(f.mail[0]!.code), { verified: true });
  const grant = await f.owner.verified(); assert.ok(grant); return grant.verificationRef;
}

test("E2E-278 one actual post-admission owner connects dedicated code entry, protected list, SAM review and one cancellation", async () => {
  const f = await cancellationSessionFixture();
  try {
    await f.read("guessed-proof"); assert.equal(f.traffic.length, 0); await f.playPending();
    const ref = await verify(f);
    // The denied read consumed its turn ID. Use a fresh turn for the protected read.
    const read = await f.agent.submit({ kind: "appointments.read.v1", turn: f.turn("verified-list"), verificationRef: ref,
      from: verificationNow, to: "2026-10-09T06:00:00.000Z", now: verificationNow }); assert.ok(read.ok);
    await f.playPending(); const proposed = await f.propose(ref); assert.ok(proposed.ok);
    await f.confirm(); assert.ok((await f.drain()).ok);
    assert.equal(f.patches, 1); assert.equal(f.recalls.length, 1);
    assert.equal(Object.values((await f.state()).actions)[0]!.status, "committed");
    assert.equal(f.claims, f.traffic.length, "every contact, list, exact target, review and mutation request reserves the same budget");
    assert.deepEqual(await f.owner.submitCode(f.mail[0]!.code), { verified: false });
    const publicOutput = JSON.stringify([f.owner, proposed, read, f.owner.beginVerification()]);
    for (const secret of [...verificationCanaries, ref, f.mail[0]!.code]) assert.equal(publicOutput.includes(secret), false);
    assert.equal((await f.state()).processedTurnIds.some(id => id.includes(f.mail[0]!.code)), false);
    await f.drain(); assert.equal(f.patches, 1);
  } finally { await f.close(); }
});

test("E2E-278 played numbered selection is consumed through the composed source and cancels exactly the chosen target", async () => {
  const f = await cancellationSessionFixture({ multiple: true });
  try {
    const ref = await verify(f); assert.ok((await f.read(ref)).ok); await f.playPending();
    assert.ok((await f.reception.selectAppointment(f.scope, f.turn("choose", "The second one"), ref, 2, verificationNow)).ok);
    await f.playPending(); assert.ok((await f.propose(ref)).ok); await f.confirm(); await f.drain();
    assert.deepEqual(f.traffic.filter(path => path.startsWith("PATCH")), ["PATCH /v1/individual_appointments/92/cancel"]);
    assert.equal((await f.owner.appointments.select(f.scope, ref, 2, verificationNow)).ok, false);
  } finally { await f.close(); }
});

test("E2E-278 bound approvals, current permission, session lifetime and emergency settings revoke composed authority", async () => {
  for (const change of ["callerApproval", "feeApproval", "member", "permission", "automation", "cancellation", "writeStop", "callEnd", "lease", "close"] as const) {
    const f = await cancellationSessionFixture();
    try {
      const ref = await verify(f); assert.ok((await f.read(ref)).ok); await f.playPending(); assert.ok((await f.propose(ref)).ok); await f.confirm();
      f.setOnRecall(async () => {
        if (change === "callerApproval") await f.replaceApproval({ enabled: false });
        if (change === "feeApproval") await f.replaceCancellation({ enabled: false });
        if (change === "member") await f.replaceAccount({ membershipVersion: "changed" });
        if (change === "permission") f.setPermitted(false);
        if (change === "automation") assert.ok((await f.policies.changeAutomationEnabled(f.scope, "1", false, "synthetic-admin")).ok);
        if (change === "cancellation") assert.ok((await f.policies.changeCancellationEnabled(f.scope, "1", false, "synthetic-admin")).ok);
        if (change === "writeStop") assert.ok((await f.ledger.stopWrites(f.scope, "synthetic-admin", "stop")).ok);
        if (change === "callEnd") assert.ok((await f.runtime.endCall(f.callId, f.sessionId, verificationNow)).ok);
        if (change === "lease") f.setTime("2026-10-04T06:01:00.000Z");
        if (change === "close") f.lifetime.abort();
      });
      await f.drain(); assert.equal(f.recalls.length, 1); assert.equal(f.patches, 0);
      assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
      assert.equal(await f.owner.verified(), undefined);
    } finally { await f.close(); }
  }
});

test("E2E-278 unknown recall or cancellation response never replays and leaves provider review pending", async () => {
  for (const lostRecall of [true, false]) {
    const f = await cancellationSessionFixture({ lostRecall, lostWrite: !lostRecall });
    try {
      const ref = await verify(f); assert.ok((await f.read(ref)).ok); await f.playPending();
      assert.ok((await f.propose(ref)).ok); await f.confirm(); await f.drain();
      assert.equal(f.recalls.length, 1); assert.equal(f.patches, lostRecall ? 0 : 1);
      assert.notEqual(Object.values((await f.state()).actions)[0]!.status, "committed");
      await f.drain(); assert.equal(f.recalls.length, 1); assert.equal(f.patches, lostRecall ? 0 : 1);
      assert.equal((await f.discovery()).pending.length, 1);
    } finally { await f.close(); }
  }
});

test("E2E-278 one lifecycle signal closes pending mail/target work and retained ports cannot regain authority", async () => {
  let code = "", releaseMail: () => void = () => undefined;
  const a = await cancellationSessionFixture({ delivery: { send: async (_email, value) => {
    code = value; return new Promise<boolean>(resolve => { releaseMail = () => resolve(true); });
  } } });
  try {
    a.owner.beginVerification(); await waitUntil(() => !!code);
    const pending = a.owner.submitCode(code); a.lifetime.abort(); releaseMail();
    assert.deepEqual(await pending, { verified: false }); assert.equal(await a.owner.verified(), undefined);
    assert.deepEqual(a.owner.beginVerification(), { prompt: verificationPrompt });
    assert.equal(a.traffic.some(path => path.includes("appointments")), false);
  } finally { await a.close(); }
  const b = await cancellationSessionFixture({ timeoutMs: 1000 });
  try {
    const ref = await verify(b); assert.ok((await b.read(ref)).ok); await b.playPending(); b.setHold();
    const pending = b.propose(ref); await waitUntil(() => b.traffic.includes("GET /v1/individual_appointments/91"));
    b.lifetime.abort(); const result = await pending;
    assert.equal(result.ok && result.value.kind === "appointmentChangeProposal" && result.value.progress.actions.length > 0, false);
    b.release(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(await b.owner.verified(), undefined); assert.equal(b.patches, 0);
    assert.equal((await b.owner.appointments.list(b.scope, ref, verificationNow, "2026-10-09T06:00:00.000Z", verificationNow)).ok, false);
  } finally { await b.close(); }
});

test("E2E-278 factory denies missing shared budgets, cross-admission data, disabled policy and closed lifetime", async () => {
  const f = await cancellationSessionFixture();
  try {
    const closed = new AbortController(); closed.abort();
    const unsafe = [ { ...f.config, cliniko: { ...f.config.cliniko, rateBudget: undefined } },
      { ...f.config, cliniko: { ...f.config.cliniko, businessId: "12" } },
      { ...f.config, inbound: { ...f.inbound, dialedNumber: "+6125550111" } },
      { ...f.config, receipt: { ...f.receipt, lifecycle: "ended" } }, { ...f.config, signal: closed.signal } ];
    for (const config of unsafe) assert.deepEqual(await ClinikoCancellationSession.create(config as typeof f.config),
      { ok: false, error: { kind: "cancellationSessionUnavailable" } });
    await f.replaceCancellation({ approved: false });
    assert.deepEqual(await ClinikoCancellationSession.create(f.config), { ok: false, error: { kind: "cancellationSessionUnavailable" } });
    assert.equal(f.traffic.length, 0);
  } finally { await f.close(); }
});

test("E2E-278 bounded factory abandons held approval work and a late directory result cannot create an owner", async () => {
  const f = await cancellationSessionFixture(); let release: () => void = () => undefined;
  try {
    const directory = { ...f.config.directory, findByEmail: f.config.directory.findByEmail.bind(f.config.directory),
      findByRef: async () => new Promise<never>(resolve => { release = () => resolve(undefined as never); }) };
    assert.deepEqual(await ClinikoCancellationSession.create({ ...f.config, directory: directory as typeof f.config.directory, timeoutMs: 25 }),
      { ok: false, error: { kind: "cancellationSessionUnavailable" } });
    release(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.traffic.length, 0);
  } finally { release(); await f.close(); }
});

test("E2E-278 failed shared provider reservations deny verification and block the final clinical edge after saved review", async () => {
  for (const before of [true, false]) {
    let denied = before;
    const f = await cancellationSessionFixture({ rateBudget: { claim: async () => denied ? { kind: "unavailable" } : null,
      observe429: async () => ({ kind: "rateLimited" }) } });
    try {
      if (before) {
        f.owner.beginVerification(); assert.deepEqual(await f.owner.submitCode("123456"), { verified: false });
        assert.equal(f.traffic.length, 0); assert.equal(f.mail.length, 0);
      } else {
        const ref = await verify(f); assert.ok((await f.read(ref)).ok); await f.playPending();
        assert.ok((await f.propose(ref)).ok); await f.confirm(); f.setOnRecall(async () => { denied = true; });
        await f.drain(); assert.equal(f.recalls.length, 1); assert.equal(f.patches, 0);
        assert.equal(await f.owner.verified(), undefined);
      }
    } finally { await f.close(); }
  }
});
