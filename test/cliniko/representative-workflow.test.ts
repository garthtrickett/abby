import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoBookingSession } from "../../src/standalone/cliniko-booking-session.ts";
import { bookingOffersFixture } from "../support/booking-offers.ts";
import { representativeFixture } from "../support/representative-selection.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { verificationNow } from "../support/caller-verification.ts";

async function fixture(guardian = false) {
  const f = await bookingOffersFixture({ budget: new ClinikoReadBudget(200, () => Date.parse(verificationNow)) });
  const r = await representativeFixture(f.ownerPorts.rateBudget, { fixture: f, operation: "appointments.book" });
  await r.verifyActor();
  if (guardian) {
    r.identity.dateOfBirth = "2014-03-05"; r.patients.get("43")!.date_of_birth = r.identity.dateOfBirth;
    r.authorizations.set("43", { ...r.authorizations.get("43")!, subjectKind: "minor", authorityKind: "guardian" });
  }
  const selected = resultValue(await r.select());
  let revoked = false;
  const base = "https://api.au5.cliniko.com/v1", requests: { path: string; body: Record<string, unknown> }[] = [];
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    if (url.pathname === "/v1/recalls" && method === "POST") {
      const body = JSON.parse(String(init?.body)); requests.push({ path: url.pathname, body });
      assert.equal(body.patient_id, "43");
      const row = { id: "71", archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes,
        patient: { links: { self: `${base}/patients/${body.patient_id}` } }, recall_type: { links: { self: `${base}/recall_types/7` } } };
      f.recalls.push(row); return Response.json(row, { status: 201 });
    }
    if (url.pathname === "/v1/individual_appointments" && method === "POST") {
      const body = JSON.parse(String(init?.body)); requests.push({ path: url.pathname, body }); assert.equal(body.patient_id, "43");
    }
    if (url.pathname === "/v1/patients/43") return Response.json(r.patients.get("43"));
    return f.ownerPorts.fetchPort(value, init);
  };
  const config = { receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
    ledger: f.ledger, policies: f.policies, lookup: f.sessionConfig.lookup,
    permission: { allows: async (_scope: unknown, patientId: string) => patientId === "43" && !revoked }, verificationBudget: { reserve: async () => true },
    delivery: r.config.delivery, directory: f.directory, callerApprovalPath: r.config.representativeCallerApprovalPath, bookingApprovalPath: f.path,
    representative: { owner: r.owner, selectionRef: selected.selectionRef },
    cliniko: r.config.cliniko, signal: r.lifetime.signal, fetchPort, clock: f.sessionConfig.clock };
  const close = async () => { await r.close(); };
  return { f, r, config, requests, close, revoke: () => { revoked = true; } };
}

for (const guardian of [false, true]) test(`E2E-383 ${guardian ? "guardian" : "adult representative"} booking uses fresh subject proof and actual played SAM consent before one native write`, async () => {
  const f = await fixture(guardian); let owner: ClinikoBookingSession | undefined;
  try {
    owner = resultValue(await ClinikoBookingSession.create(f.config));
    owner.beginVerification(); const deadline = Date.now() + 5000;
    while (!f.r.mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
    assert.equal(f.r.mail[0]?.email, "subject-one-private@example.test");
    assert.equal((await owner.submitCode(f.r.mail[0]!.code)).verified, true);
    const reception = new TextReception(f.f.ledger, f.f.policies, owner.effects);
    const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.f.scope }, f.f.policies, reception, undefined, undefined, undefined, f.f.ledger);
    async function play() {
      const pending = (await f.f.state()).pendingPresentationId!; assert.ok(pending);
      resultValue(await f.f.runtime.startPresentation(f.f.callId, pending, f.f.sessionId, verificationNow));
      resultValue(await f.f.runtime.resolvePresentation(f.f.callId, pending, "played", f.f.sessionId, verificationNow));
    }
    if ((await f.f.state()).pendingPresentationId) await play();
    resultValue(await agent.submit({ kind: "booking.offers.read.v1", turn: f.f.turn("menu"), from: "2026-10-08", to: "2026-10-08", now: verificationNow }));
    await play();
    resultValue(await agent.submit({ kind: "booking.offers.select.v1", turn: f.f.turn("select"), choice: 1, now: verificationNow }));
    const action = Object.values((await f.f.state()).actions)[0]!; assert.equal(action.mutation?.request.kind, "book");
    assert.equal(f.requests.length, 0);
    await play(); resultValue(await reception.affirm(f.f.scope, f.f.turn("affirm", "Yes"), action.key, action.digest, verificationNow));
    await reception.drain(f.f.scope, f.f.callId, verificationNow);
    const complete = (await f.f.state()).actions[action.key]!;
    assert.equal(complete.status, "committed"); assert.equal(complete.hostRef, "cliniko:appointment:91");
    assert.equal(f.requests.filter(row => row.path === "/v1/individual_appointments").length, 1);
    assert.equal(await f.f.session.verifiedSubject("appointments.book").then(subject => subject?.patientRef), "482746192837465");
  } finally { owner?.dispose(); await f.close(); }
});

test("E2E-383 workflow binding rejects foreign operation/account/admission and an unapproved representative method", async () => {
  for (const fault of ["account", "business", "session", "caller", "source"] as const) {
    const f = await fixture();
    try {
      const config = { ...f.config, cliniko: { ...f.config.cliniko }, inbound: { ...f.config.inbound } };
      if (fault === "account") config.cliniko.apiKey = "other-account-au5";
      if (fault === "business") config.cliniko.businessId = "12";
      if (fault === "session") config.sessionId = "other-session";
      if (fault === "caller") config.inbound.presentedCallerNumber = "+61499999000";
      if (fault === "source") config.callerApprovalPath = f.f.config.path;
      assert.equal((await ClinikoBookingSession.create(config)).ok, false);
      assert.equal(f.r.mail.length, 0); assert.equal(f.requests.length, 0);
    } finally { await f.close(); }
  }
});

test("E2E-383 clinical operation permission remains independent of representative authority", async () => {
  const f = await fixture(); let owner: ClinikoBookingSession | undefined;
  try {
    owner = resultValue(await ClinikoBookingSession.create(f.config)); f.revoke();
    owner.beginVerification(); assert.equal((await owner.submitCode("000000")).verified, false);
    assert.equal(f.r.mail.length, 0); assert.equal(f.requests.length, 0);
    assert.ok(await f.f.session.verified(), "the independent self actor remains verified");
  } finally { owner?.dispose(); await f.close(); }
});

test("E2E-383 expired workflow construction disposes a delegated verifier that finishes later", async () => {
  const f = await fixture();
  let release: () => void = () => undefined, entered: () => void = () => undefined;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.r.owner.verifier.bind(f.r.owner);
  let late: Awaited<ReturnType<typeof original>> | undefined;
  let completed: () => void = () => undefined;
  const completedPromise = new Promise<void>(resolve => { completed = resolve; });
  f.r.owner.verifier = async (...args: Parameters<typeof original>) => {
    entered(); await gate; late = await original(...args); completed(); return late;
  };
  try {
    const building = ClinikoBookingSession.create({ ...f.config, timeoutMs: 1000 });
    await enteredPromise; assert.equal((await building).ok, false);
    release(); await completedPromise; await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(late?.ok); late.value.begin(); assert.equal((await late.value.submitCode("000000")).verified, false);
    assert.equal(f.r.mail.length, 0); assert.equal(f.requests.length, 0); assert.ok(await f.f.session.verified());
  } finally { release(); if (late?.ok) late.value.dispose(); await f.close(); }
});
