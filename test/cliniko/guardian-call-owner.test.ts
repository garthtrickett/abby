// E2E-426: clinic-approved non-patient guardian records and separate patient proof.
import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoRepresentativeCallOwner } from "../../src/standalone/cliniko-representative-call-owner.ts";
import { ClinikoGuardianSelection } from "../../src/standalone/cliniko-guardian-selection.ts";
import { isRepresentativeSelection } from "../../src/standalone/workflow-caller-verification.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { guardianCallOwnerFixture } from "../support/guardian-call-owner.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";

test("non-patient guardian root reaches one exact native booking with separate caller and patient verification", async () => {
  const f = await guardianCallOwnerFixture(); let owner: ClinikoRepresentativeCallOwner | undefined;
  try {
    owner = resultValue(await ClinikoRepresentativeCallOwner.create({ ...f.config, context: { ...f.config.context,
      lookup: { candidates: async () => { throw new Error("guardian identity cannot use caller patient candidates"); } } } })); assert.equal(owner.callerMethodChoiceRequired, false);
    assert.equal(f.reads.length, 0); assert.deepEqual(f.counts, { identities: 0, authorities: 0 });
    owner.beginCallerVerification(); await f.base.waitForMail(1); assert.equal(f.base.mail[0]!.email, f.state.guardianEmail);
    assert.equal((await owner.submitCallerCode(f.base.mail[0]!.code)).verified, true);
    assert.equal((await owner.selectPatient(f.base.r.identity)).ok, true); assert.equal(owner.beginPatientVerification(), true);
    await f.base.waitForMail(2); assert.equal(f.base.mail[1]!.email, "subject-one-private@example.test");
    assert.equal((await f.flow.submitCode(f.base.mail[1]!.code)).verified, true);
    const reception = new TextReception(f.base.f.ledger, f.base.f.policies, f.flow);
    const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.base.f.scope }, f.base.f.policies, reception, undefined, undefined, undefined, f.base.f.ledger);
    if ((await f.base.f.state()).pendingPresentationId) await f.base.play();
    resultValue(await agent.submit({ kind: "booking.offers.read.v1", turn: f.base.f.turn("menu"), from: "2026-10-08", to: "2026-10-08", now: verificationNow })); await f.base.play();
    resultValue(await agent.submit({ kind: "booking.offers.select.v1", turn: f.base.f.turn("select"), choice: 1, now: verificationNow }));
    const action = Object.values((await f.base.f.state()).actions)[0]!; assert.ok(action); assert.equal(f.base.writes, 0);
    await f.base.play(); resultValue(await reception.affirm(f.base.f.scope, f.base.f.turn("affirm", "Yes"), action.key, action.digest, verificationNow));
    await reception.drain(f.base.f.scope, f.base.f.callId, verificationNow); assert.equal(f.base.writes, 1);
    assert.equal((await f.base.f.state()).actions[action.key]!.status, "committed");
    assert.ok(f.reads.some(path => path.includes("/contacts/"))); assert.equal(f.reads.some(path => path.endsWith(`/patients/${verificationCanaries[2]}`)), false);
    const publicData = JSON.stringify([await f.base.f.state(), await f.flow.publicIntentContext()]);
    for (const secret of [f.base.r.identity.firstName, f.base.r.identity.lastName, f.base.r.identity.dateOfBirth,
      ...f.base.mail.flatMap(message => [message.email, message.code]), f.state.identity!.recordRef, f.state.authority!.authorityRef]) assert.equal(publicData.includes(secret), false);
  } finally { owner?.dispose(); await f.close(); }
});

test("two approved identity sources require one private choice before either code or patient lookup", async () => {
  const f = await guardianCallOwnerFixture({ both: true }); let owner: ClinikoRepresentativeCallOwner | undefined;
  try {
    owner = resultValue(await ClinikoRepresentativeCallOwner.create(f.config)); assert.equal(owner.callerMethodChoiceRequired, true);
    assert.equal(owner.beginCallerVerification(), false); assert.deepEqual(await owner.submitCallerCode("000000"), { verified: false });
    assert.equal((await owner.selectPatient(f.base.r.identity)).ok, false); assert.equal(f.base.mail.length, 0); assert.equal(f.reads.length, 0);
    assert.equal(owner.chooseCallerMethod("forged" as never), false); assert.equal(owner.callerMethodChoiceRequired, true);
    assert.equal(owner.chooseCallerMethod("guardianRecord"), true); assert.equal(owner.callerMethodChoiceRequired, false);
    assert.equal(owner.chooseCallerMethod("clinicPatient"), false); assert.equal(owner.chooseCallerMethod("guardianRecord"), false);
    assert.equal(owner.beginCallerVerification(), true); await f.base.waitForMail(1); assert.equal(f.base.mail[0]!.email, f.state.guardianEmail);
    assert.equal(owner.chooseCallerMethod("clinicPatient"), false); assert.equal(f.reads.some(path => path.endsWith(`/patients/${verificationCanaries[2]}`)), false);
  } finally { owner?.dispose(); await f.close(); }
});

test("native-patient method remains independently selectable alongside guardian records", async () => {
  const f = await guardianCallOwnerFixture({ both: true, adult: true }); let owner: ClinikoRepresentativeCallOwner | undefined;
  try {
    owner = resultValue(await ClinikoRepresentativeCallOwner.create(f.config)); assert.equal(owner.chooseCallerMethod("clinicPatient"), true);
    owner.beginCallerVerification(); await f.base.waitForMail(1); assert.equal(f.base.mail[0]!.email, verificationCanaries[0]);
    assert.equal((await owner.submitCallerCode(f.base.mail[0]!.code)).verified, true);
    assert.equal((await owner.selectPatient(f.base.r.identity)).ok, true); assert.equal(owner.beginPatientVerification(), true);
    await f.base.waitForMail(2); assert.equal((await f.flow.submitCode(f.base.mail[1]!.code)).verified, true);
    assert.deepEqual(f.counts, { identities: 0, authorities: 0 }); assert.equal(f.reads.some(path => path.includes("/contacts/")), false);
  } finally { owner?.dispose(); await f.close(); }
});

test("chosen missing or withdrawn guardian records never fall back to an available patient identity", async () => {
  for (const kind of ["missing", "withdrawn"] as const) {
    const f = await guardianCallOwnerFixture({ both: true }); let owner: ClinikoRepresentativeCallOwner | undefined;
    try {
      owner = resultValue(await ClinikoRepresentativeCallOwner.create(f.config)); owner.chooseCallerMethod("guardianRecord");
      if (kind === "missing") f.state.identity = undefined;
      else f.state.identity = { ...f.state.identity!, enabled: false };
      owner.beginCallerVerification(); assert.equal((await owner.submitCallerCode("000000")).verified, false);
      assert.equal(owner.chooseCallerMethod("clinicPatient"), false); assert.equal(f.base.mail.length, 0); assert.equal(f.reads.length, 0);
    } finally { owner?.dispose(); await f.close(); }
  }
});

test("both-source setup rejects an unapproved source instead of silently reducing to the other method", async () => {
  for (const kind of ["guardian", "native"] as const) {
    const f = await guardianCallOwnerFixture({ both: true });
    try {
      if (kind === "guardian") await f.replaceApproval({ enabled: false }); else await f.base.r.replaceApproval({ enabled: false });
      assert.equal((await ClinikoRepresentativeCallOwner.create(f.config)).ok, false); assert.equal(f.base.mail.length, 0); assert.equal(f.reads.length, 0);
    } finally { await f.close(); }
  }
});

test("guardian actor process and independent subject permission remain current at their separate boundaries", async () => {
  for (const kind of ["subject", "process", "authority"] as const) {
    const f = await guardianCallOwnerFixture(); let owner: ClinikoRepresentativeCallOwner | undefined;
    try {
      owner = resultValue(await ClinikoRepresentativeCallOwner.create(f.config)); owner.beginCallerVerification(); await f.base.waitForMail(1);
      assert.equal((await owner.submitCallerCode(f.base.mail[0]!.code)).verified, true);
      if (kind === "process") await f.replaceApproval({ enabled: false });
      if (kind === "authority") f.state.authority = undefined;
      if (kind === "subject") f.base.revokeSubject();
      const selected = await owner.selectPatient(f.base.r.identity);
      if (kind === "subject") { assert.equal(selected.ok, true); owner.beginPatientVerification(); assert.equal((await f.flow.submitCode("000000")).verified, false); }
      else assert.equal(selected.ok, false);
      assert.equal(f.base.mail.length, 1); assert.equal(f.base.writes, 0);
    } finally { owner?.dispose(); await f.close(); }
  }
});

test("root close bounds a pending guardian lookup and suppresses every late delivery", async () => {
  const f = await guardianCallOwnerFixture(); let owner: ClinikoRepresentativeCallOwner | undefined, release: () => void = () => undefined;
  try {
    owner = resultValue(await ClinikoRepresentativeCallOwner.create(f.config)); let entered: () => void = () => undefined;
    const held = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    f.state.beforeIdentity = async () => { entered(); await resume; };
    owner.beginCallerVerification(); await held; owner.dispose(); assert.equal((await owner.submitCallerCode("000000")).verified, false);
    release(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.base.mail.length, 0); assert.equal(f.reads.length, 0);
    assert.equal(owner.chooseCallerMethod("clinicPatient"), false);
  } finally { release(); owner?.dispose(); await f.close(); }
});

test("guardian root snapshots the original clinic sources before asynchronous process setup", async () => {
  const f = await guardianCallOwnerFixture(); let owner: ClinikoRepresentativeCallOwner | undefined;
  try {
    const pending = ClinikoRepresentativeCallOwner.create(f.config);
    f.provision.identities.read = async () => { throw new Error("late swapped private identity source"); };
    f.provision.authorities.read = async () => { throw new Error("late swapped private authority source"); };
    owner = resultValue(await pending); owner.beginCallerVerification(); await f.base.waitForMail(1);
    assert.equal((await owner.submitCallerCode(f.base.mail[0]!.code)).verified, true); assert.equal((await owner.selectPatient(f.base.r.identity)).ok, true);
  } finally { owner?.dispose(); await f.close(); }
});

test("guardian selection seam rejects structural owners and modified guardian methods", () => {
  assert.equal(isRepresentativeSelection({ select: () => undefined, verifier: () => undefined }), false);
  const fake = Object.create(ClinikoGuardianSelection.prototype) as ClinikoGuardianSelection;
  fake.verifier = async () => ({ ok: false, error: { kind: "representativeUnavailable" } });
  assert.equal(isRepresentativeSelection(fake), false);
});

for (const operation of ["appointments.read", "cancel", "reschedule"] as const) {
  test(`private guardian ${operation} uses a fresh operation-bound patient proof and the existing native workflow`, async context => {
    const f = await guardianCallOwnerFixture({ operation });
    let phase = "verification";
    const claims: Record<string, { allowed: number; denied: number }> = {}, budget = f.config.context.cliniko.rateBudget, claim = budget.claim;
    context.mock.method(budget, "claim", function(this: typeof budget) {
      const count = (result: Awaited<ReturnType<typeof claim>>) => { const record = claims[phase] ??= { allowed: 0, denied: 0 };
        result === null ? record.allowed++ : record.denied++; return result; };
      const result = claim.call(this); return result instanceof Promise ? result.then(count) : count(result);
    });
    const reception = new TextReception(f.base.f.ledger, f.base.f.policies, f.flow, undefined, {
      list: (...args) => f.flow.appointments!.list(...args), select: (...args) => f.flow.appointments!.select!(...args),
    }, undefined, undefined, f.flowConfig.clock);
    const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.base.f.scope }, f.base.f.policies, reception, undefined, undefined, undefined, f.base.f.ledger);
    try {
      const callerAppointment = structuredClone(f.change!.rows.get("93"));
      resultValue(await reception.startWorkflow(f.base.f.scope, f.base.f.turn("guardian-start", "Help with an appointment for my child"), operation,
        verificationNow, (await f.base.f.state()).conversationRevision, undefined, false, undefined, true)); await f.base.play();
      const owner = f.flow.representativeInputOwner; assert.ok(owner); assert.equal(owner.callerMethodChoiceRequired, false);
      owner.beginCallerVerification(); await f.base.waitForMail(1); assert.equal(f.base.mail[0]!.email, f.state.guardianEmail);
      assert.equal((await owner.submitCallerCode(f.base.mail[0]!.code)).verified, true);
      resultValue(await owner.selectPatient(f.base.r.identity)); assert.equal(owner.beginPatientVerification(), true);
      await f.base.waitForMail(2); assert.equal((await f.flow.submitCode(f.base.mail[1]!.code)).verified, true);
      assert.equal((await f.flow.choose(operation === "cancel" ? "reschedule" : "cancel")).ok, false, "one patient operation proof cannot silently select a different action");
      phase = "proposal";
      if (operation === "appointments.read") {
        resultValue(await reception.enquireAppointments(f.base.f.scope, f.base.f.turn("guardian-read"), { from: verificationNow, to: "2026-10-09T06:00:00.000Z" }, verificationNow));
        assert.equal((await f.base.f.state()).appointmentReads.at(-1)!.status, "shown"); assert.equal(f.change!.patches.length, 0);
      } else {
        if (operation === "cancel") {
          const grant = await f.flow.cancellationProof(); assert.ok(grant);
          resultValue(await agent.submit({ kind: "appointments.read.v1", turn: f.base.f.turn("guardian-appointments"), verificationRef: grant.verificationRef,
            from: verificationNow, to: "2026-10-09T06:00:00.000Z", now: verificationNow })); await f.base.play();
          resultValue(await agent.submit({ kind: "appointments.change.propose.v1", turn: f.base.f.turn("guardian-cancel"),
            selection: { kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" }, now: verificationNow }));
        } else {
          for (const stage of ["targets", "offers"] as const) {
            resultValue(await agent.submit({ kind: "rescheduling.menu.read.v1", turn: f.base.f.turn(`guardian-${stage}`), stage,
              from: stage === "targets" ? verificationNow : "2026-10-08", to: stage === "targets" ? "2026-10-09T06:00:00.000Z" : "2026-10-08", now: verificationNow }));
            await f.base.play(); resultValue(await agent.submit({ kind: "rescheduling.menu.select.v1", turn: f.base.f.turn(`guardian-choice-${stage}`), stage, choice: 1, now: verificationNow }));
            if (stage === "targets") await f.base.play();
          }
        }
        const action = Object.values((await f.base.f.state()).actions).at(-1)!; assert.ok(action); assert.equal(action.status, "awaitingConfirmation");
        assert.equal(f.change!.patches.length, 0); await f.base.play(); phase = "confirmation";
        resultValue(await reception.affirm(f.base.f.scope, f.base.f.turn("guardian-yes", "Yes"), action.key, action.digest, verificationNow));
        phase = "dispatch"; resultValue(await reception.drain(f.base.f.scope, f.base.f.callId, verificationNow));
        assert.equal((await f.base.f.state()).actions[action.key]!.status, "committed", JSON.stringify({ claims,
          contactReads: f.reads.filter(path => path.includes("/contacts/")).length, patientReads: f.reads.filter(path => path.includes("/patients/")).length,
          patches: f.change!.patches.length, reviews: f.base.f.recalls.length }));
        assert.deepEqual(f.change!.patches.map(row => ({ id: row.id, kind: row.kind })), [{ id: "91", kind: operation }]);
      }
      assert.deepEqual(f.change!.rows.get("93"), callerAppointment); assert.equal(f.reads.some(path => path.endsWith(`/patients/${verificationCanaries[2]}`)), false);
    } finally { await f.close(); }
  });
}

test("guardian and selected patient may share registered email while retaining separate code transactions", async () => {
  const f = await guardianCallOwnerFixture(); let owner: ClinikoRepresentativeCallOwner | undefined;
  try {
    f.state.guardianEmail = "subject-one-private@example.test";
    owner = resultValue(await ClinikoRepresentativeCallOwner.create(f.config)); owner.beginCallerVerification(); await f.base.waitForMail(1);
    assert.equal((await owner.submitCallerCode(f.base.mail[0]!.code)).verified, true); resultValue(await owner.selectPatient(f.base.r.identity));
    owner.beginPatientVerification(); await f.base.waitForMail(2); assert.equal(f.base.mail[0]!.email, f.base.mail[1]!.email);
    const firstCode = f.base.mail[0]!.code, secondCode = f.base.mail[1]!.code;
    const wrongCode = firstCode === secondCode ? (secondCode === "000000" ? "999999" : "000000") : firstCode;
    assert.equal((await f.flow.submitCode(wrongCode)).verified, false); assert.equal((await f.flow.submitCode(secondCode)).verified, true);
    assert.equal(f.base.writes, 0);
  } finally { owner?.dispose(); await f.close(); }
});
