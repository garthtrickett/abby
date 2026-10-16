// E2E-419: independent cold staff resolution never reconstructs caller continuation.
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { ClinikoClassMoveRecovery } from "../../src/standalone/cliniko-class-move-recovery.ts";
import type { HostActor } from "../../src/reference/command-gateway.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { DisabledStandaloneHost } from "../../src/standalone/disabled-host.ts";
import { createHostAuthenticatedDashboardServer } from "../../src/standalone/dashboard/server.ts";
import { classMoveFixture } from "../support/class-move.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

async function fixture(pass: boolean, finish: "moved" | "restored" | "partial" = "moved", cross = false, lost?: "original" | "association") {
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

for (const variant of ["ordinary", "pass", "crossCasePass"] as const) test(`cold staff review inspects an acknowledged ${variant} move without caller authority or mutation`, async () => {
  const pass = variant !== "ordinary", x = await fixture(pass, "moved", variant === "crossCasePass");
  try {
    x.acknowledge(); x.elapse();
    const before = await x.f.state(), writes = x.f.writes.length;
    const result = resultValue(await x.recovery.inspect(x.request));
    assert.equal(result.kind, "reviewedMoved"); assert.equal(result.reviewAcknowledged, true);
    assert.deepEqual(result.progress, { original: "inspectedCancelled", replacement: "inspectedActive", caseAssociation: pass ? "inspectedLinked" : "notApplicable" });
    assert.equal(x.f.writes.length, writes); assert.deepEqual(await x.f.state(), before);
    assert.doesNotMatch(JSON.stringify(result), /patient|cliniko:|private|entitlement|proof|staff-class-review|@/);
  } finally { await x.close(); }
});

for (const pass of [false, true]) test(`cold staff review requires the exact cancelled replacement citation for ${pass ? "pass" : "ordinary"} restoration`, async () => {
  const x = await fixture(pass, "restored");
  try {
    x.acknowledge(); x.elapse();
    assert.equal(resultValue(await x.recovery.inspect(x.request)).kind, "needsReview", "active-roster absence cannot prove restoration");
    x.elapse();
    const result = resultValue(await x.recovery.inspect({ ...x.request, replacementAttendeeRef: "cliniko:attendee:401" }));
    assert.equal(result.kind, "reviewedRestored");
    assert.equal(result.progress.original, "inspectedActive"); assert.equal(result.progress.replacement, "inspectedCancelled");
  } finally { await x.close(); }
});

test("native review acknowledgement alone cannot resolve a partial move", async () => {
  const x = await fixture(true, "partial");
  try {
    x.acknowledge(); x.elapse();
    const result = resultValue(await x.recovery.inspect(x.request));
    assert.equal(result.kind, "needsReview"); assert.equal(result.progress.original, "inspectedActive");
    assert.deepEqual(x.f.writes.map(w => w.path), ["/v1/attendees"]);
  } finally { await x.close(); }
});

test("current joint state does not resolve an unacknowledged provider review", async () => {
  const x = await fixture(false);
  try {
    x.elapse(); const result = resultValue(await x.recovery.inspect(x.request));
    assert.equal(result.kind, "needsReview"); assert.equal(result.reviewAcknowledged, false);
    assert.equal(result.progress.original, "inspectedCancelled");
  } finally { await x.close(); }
});

for (const fault of ["signedOut", "foreignClinic", "staff", "notPermitted", "actorInBody", "forgedReplacement"] as const)
test(`cold class review refuses ${fault} without native mutation`, async () => {
  const x = await fixture(false);
  try {
    x.acknowledge(); x.elapse();
    if (fault === "signedOut") x.setActor(null);
    if (fault === "staff") x.setActor({ ...x.f.account.actor, role: "staff" });
    if (fault === "foreignClinic") x.setActor({ ...x.f.account.actor, scope: { ...x.f.scope, clinicId: "foreign" } });
    if (fault === "notPermitted") x.deny();
    const result = await x.recovery.inspect(fault === "actorInBody" ? Object.assign({}, x.request, { actor: x.f.account.actor }) :
      fault === "forgedReplacement" ? { ...x.request, replacementAttendeeRef: "cliniko:attendee:999" } : x.request);
    if (fault === "forgedReplacement") { assert.equal(resultValue(result).kind, "needsReview"); }
    else assert.equal(result.ok, false);
    if (["signedOut", "staff", "foreignClinic", "actorInBody"].includes(fault)) assert.equal(x.traffic.length, 0);
  } finally { await x.close(); }
});


for (const fault of ["permission", "directoryVersion", "sourcePolicy", "reviewVersion", "roster", "entitlement", "backwardsClock", "abort"] as const)
test(`cold class review discards observations after ${fault} changes during native inspection`, async () => {
  const x = await fixture(true), external = new AbortController();
  try {
    x.acknowledge(); x.elapse(); const before = await x.f.state(), writes = x.f.writes.length;
    let changed = false;
    x.beforeRead(async path => {
      if (changed || !path.startsWith("/v1/group_appointments")) return;
      changed = true;
      if (fault === "permission") x.deny();
      if (fault === "directoryVersion") await x.f.replaceAccount({ membershipVersion: "changed-membership" });
      if (fault === "sourcePolicy") await x.f.replaceSource({ enabled: false });
      if (fault === "reviewVersion") x.f.recalls[0]!.updated_at = new Date(Date.parse(x.f.config.clock()) + 1).toISOString();
      if (fault === "roster") x.f.native.attendees.find(row => row.id === "401")!.cancelled_at = x.f.config.clock();
      if (fault === "entitlement") x.f.movePass!.deny();
      if (fault === "backwardsClock") x.f.setTime(new Date(Date.parse(x.f.config.clock()) - 1).toISOString());
      if (fault === "abort") external.abort();
    });
    const result = await x.recovery.inspect(x.request, external.signal);
    assert.ok(changed);
    if (fault === "roster" || fault === "entitlement") {
      assert.ok(!result.ok || result.value.kind === "needsReview", "changed native state cannot be resolved as moved");
    } else assert.equal(result.ok, false);
    assert.equal(x.f.writes.length, writes); assert.deepEqual(await x.f.state(), before);
  } finally { await x.close(); }
});

for (const fault of ["creationMarker", "unapprovedCase", "cancellationReason"] as const)
test(`ordinary cold resolution preserves uncertainty for a changed ${fault}`, async () => {
  const x = await fixture(false);
  try {
    x.acknowledge(); x.elapse();
    if (fault === "creationMarker") x.f.native.attendees.find(row => row.id === "401")!.notes = "another creation marker";
    if (fault === "unapprovedCase") x.f.native.attendees.find(row => row.id === "401")!.patient_case = { links: { self: "https://api.au5.cliniko.com/v1/patient_cases/999" } };
    if (fault === "cancellationReason") x.f.native.attendees.find(row => row.id === "101")!.cancellation_reason = 10;
    assert.equal(resultValue(await x.recovery.inspect(x.request)).kind, "needsReview");
  } finally { await x.close(); }
});

test("cold ordinary resolution rechecks joint class state after exact attendance inspection", async () => {
  const x = await fixture(false);
  try {
    x.acknowledge(); x.elapse(); let changed = false;
    x.beforeRead(path => {
      if (path !== "/v1/attendees/101" || changed) return;
      changed = true; x.f.native.attendees.find(row => row.id === "401")!.cancelled_at = x.f.config.clock();
    });
    assert.equal((await x.recovery.inspect(x.request)).ok, false);
    assert.ok(changed);
  } finally { await x.close(); }
});

test("cold class review HTTP route requires fresh host identity, same origin, explicit provisioning and fixed output", async () => {
  const x = await fixture(false);
  let actor: HostActor | null = x.f.account.actor, factories = 0, swapIdentity = false;
  const bundle = join(x.f.folder, "synthetic-dashboard.js"); await writeFile(bundle, "export {};\n");
  const identity = { publicOrigin: "http://127.0.0.1:0", resolveActor: () => actor,
    gatewayFor: (bound: HostActor) => new CommandGateway(bound, x.f.policies,
      new TextReception(x.f.ledger, x.f.policies, new DisabledStandaloneHost())),
    classMovementRecoveryFor: () => {
      factories++; if (swapIdentity) actor = { ...x.f.account.actor, actorRef: "changed-session-actor" };
      return x.recovery;
    } };
  const server = await createHostAuthenticatedDashboardServer(identity, bundle);
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
    const origin = "http://127.0.0.1:" + address.port, endpoint = origin + "/api/class-movements/review";
    const post = (input: unknown, suppliedOrigin = origin, query = "") => fetch(endpoint + query, { method: "POST",
      headers: { Origin: suppliedOrigin, "Content-Type": "application/json" }, body: JSON.stringify(input) });
    actor = null; assert.equal((await post(x.request)).status, 403);
    actor = { ...x.f.account.actor, role: "staff" }; assert.equal((await post(x.request)).status, 403);
    actor = x.f.account.actor;
    for (const extra of ["actor", "patientId", "verificationRef", "stage", "termsVersion"])
      assert.equal((await post({ ...x.request, [extra]: "caller-injected" })).status, 400);
    assert.equal((await post(x.request, "https://foreign.example.test")).status, 403);
    assert.equal((await post(x.request, origin, "?patientId=42")).status, 400);
    assert.equal(factories, 0);
    swapIdentity = true; assert.equal((await post(x.request)).status, 403); assert.equal(factories, 1);
    assert.equal(x.traffic.length, 0, "identity change after host factory cannot reach protected native reads");
    swapIdentity = false; actor = x.f.account.actor; x.acknowledge(); x.elapse();
    const inspect = x.recovery.inspect.bind(x.recovery);
    x.recovery.inspect = async (...args: Parameters<typeof inspect>) => {
      const result = await inspect(...args);
      return result.ok ? ok({ ...result.value, privateProof: "private-proof-canary", nativePatient: "native-patient-canary" }) : result;
    };
    const response = await post(x.request); assert.equal(response.status, 200);
    const text = await response.text(), body = JSON.parse(text) as { value: { kind: string } };
    assert.equal(body.value.kind, "reviewedMoved"); assert.doesNotMatch(text, /private-proof|native-patient|privateProof|nativePatient/);
    assert.equal(factories, 2);
    for (const mode of ["setup", "unprovisioned"] as const) {
      const { classMovementRecoveryFor, ...withoutFactory } = identity;
      const limited = await createHostAuthenticatedDashboardServer(mode === "setup" ? { ...identity, surface: "availabilitySetup" } : withoutFactory, bundle);
      try {
        limited.listen(0, "127.0.0.1"); await once(limited, "listening"); const a = limited.address(); assert.ok(a && typeof a !== "string");
        const local = "http://127.0.0.1:" + a.port;
        assert.equal((await fetch(local + "/api/class-movements/review", { method: "POST", headers: { Origin: local, "Content-Type": "application/json" }, body: JSON.stringify(x.request) })).status, 404);
        assert.equal(factories, 2);
      } finally { limited.closeAllConnections(); await new Promise<void>(resolve => limited.close(() => resolve())); }
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await x.close(); }
});


for (const pass of [false, true]) test(`independent staff observation cannot promote an uncertain ${pass ? "association" : "cancellation"} caller action`, async () => {
  const x = await fixture(pass, "moved", false, pass ? "association" : "original");
  try {
    x.acknowledge(); x.elapse(); const before = await x.f.state();
    assert.equal(before.actions[x.initial.key]!.status, "needsReview");
    assert.equal(before.actions[x.initial.key]!.classMovement?.outcome, "needsReview");
    const result = resultValue(await x.recovery.inspect(x.request));
    assert.equal(result.kind, "reviewedMoved");
    assert.deepEqual(await x.f.state(), before, "staff assessment does not commit the original uncertain call");
    assert.equal(x.f.writes.length, pass ? 3 : 2);
  } finally { await x.close(); }
});
