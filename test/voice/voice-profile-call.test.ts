import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { SharedNumberIntakeService } from "../../src/voice/shared-number-intake.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import { voiceClinicScope } from "../../src/core/voice-profile.ts";
import { captureVoiceProfile, listVoiceOptions } from "../../src/core/voice-profile-registry.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ClinicPolicyRouter, ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { OpenAIVoiceProfileHost } from "../../src/voice/openai-voice-profile.ts";
import { value } from "../support/voice-settings-contract.ts";
import type { OpenAIVoiceProfileConfig } from "../../src/voice/openai-voice-profile.ts";

const now = "2026-10-03T00:00:00.000Z", date = "2026-10-04", startsAt = "2026-10-04T00:00:00.000Z";
class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sessions: unknown[] = [];
  closed = 0;
  send(body: string) {
    const message = JSON.parse(body);
    if (message.type === "session.update") {
      this.sessions.push(message.session);
      this.emit("message", JSON.stringify({ type: "session.updated", session: message.session }));
    }
  }
  close() { this.closed++; this.readyState = 3; this.emit("close"); }
  terminate() { this.close(); }
}
function fixture(options: Partial<OpenAIVoiceProfileConfig> = {}) {
  const scope = { tenantId: `voice-call-${randomUUID()}`, clinicId: "clinic", locationId: "first" };
  const requests: Array<{ model: string; voice: string; input: string }> = [], sockets: Socket[] = [];
  let approved = true, qualityVersion = "synthetic-quality.v1", availabilityReads = 0;
  const host = new OpenAIVoiceProfileHost({ apiKey: "synthetic-openai-key", mode: "keypadAvailability",
    quality: (bound, hash) => approved && bound.tenantId === scope.tenantId && bound.clinicId === scope.clinicId
      ? ok({ configurationHash: hash, qualityVersion }) : err({ kind: "readinessFailed", missing: ["voiceProfile"] }),
    fetch: (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(new Uint8Array(960), { status: 200, headers: { "Content-Type": "audio/pcm" } });
    }) as typeof fetch,
    socketFactory: () => { const socket = new Socket(); sockets.push(socket); queueMicrotask(() => socket.emit("open")); return socket as never; },
    ...options,
  });
  const policy = new MemoryPolicyStore(undefined, () => now, async () => ok(true), undefined, undefined, undefined, host);
  const ledger = new MemoryLedger();
  const number = "+6125550123", account = `voice-account-${randomUUID()}`;
  const routing = new ReferenceNumberRoutingHost([{ ...scope, dialedNumber: number, accountRef: account, routeVersion: "voice-route.v1" }]);
  const call = (runtime: OpenAIVoiceProfileConfig["runtime"] = {}) => {
    const completion: Array<{ playbackId: string; lastSequence: number; status: "played" }> = [];
    const instance = createEmbeddedVoiceComposition({ event: { key: { accountRef: account, providerCallRef: randomUUID() },
      dialedNumber: number, receivedAt: now }, sessionId: `session-${randomUUID()}`, policy, ledger, routing,
      host: new ReferenceClinicHost([], []), speech: host, readiness: async () => ok(true), now: () => now,
      resolveIntent: async () => ok({ kind: "handoff", reason: "callerRequested" }),
      availability: { list: async bound => { availabilityReads++; return ok({ kind: "times", scope: bound,
        sourceRef: "public-schedule", timeZone: "Australia/Sydney", observedAt: now, startsAt: [startsAt], reservable: false }); } },
      output: { queueChunk: async () => "queued", finishQueue: async (playbackId, lastSequence) => {
        completion.push({ playbackId, lastSequence, status: "played" }); return "queued";
      }, clear: async () => true }, ...runtime,
    });
    const acknowledge = async () => { const receipt = completion.shift(); assert.ok(receipt); assert.ok((await instance.acceptPlaybackCompletion(receipt, now)).ok); };
    return { instance, acknowledge };
  };
  return { scope, policy, ledger, host, requests, sockets, call,
    reads: () => availabilityReads, approve: (state: boolean) => { approved = state; }, quality: (version: string) => { qualityVersion = version; } };
}
async function configure(app: ReturnType<typeof fixture>, locale = "en-AU", voiceId = "coral") {
  assert.ok((await app.policy.changeVoiceSetting(app.scope, "0", "locale", locale, "owner")).ok);
  assert.ok((await app.policy.changeVoiceSetting(app.scope, "1", "voiceId", voiceId, "owner")).ok);
  assert.ok((await app.policy.changeAutomationEnabled(app.scope, "0", true, "owner")).ok);
}
async function availability(call: ReturnType<ReturnType<typeof fixture>["call"]>) {
  assert.ok((await call.instance.acceptKeypadAvailabilityRange(date, date, now)).ok);
  await call.acknowledge();
}

test("E2E-258 E2E-259 unset and partial settings deny complete call before provider construction and patient reads", async () => {
  const app = fixture();
  assert.ok((await app.policy.changeAutomationEnabled(app.scope, "0", true, "owner")).ok);
  for (const partial of [false, true]) {
    if (partial) assert.ok((await app.policy.changeVoiceSetting(app.scope, "0", "locale", "en-AU", "owner")).ok);
    const call = app.call();
    const started = await call.instance.begin(now);
    assert.ok(!started.ok && started.error.kind === "readinessFailed");
    assert.equal(app.sockets.length, 0); assert.equal(app.requests.length, 0); assert.equal(app.reads(), 0);
  }
});
for (const kind of ["locale", "voiceId"] as const) {
  test(`E2E-${kind === "locale" ? "258" : "259"} complete captured call uses actual ${kind} adapter parameters before and after edit and clear`, async () => {
    const app = fixture(); await configure(app);
    const old = app.call(); assert.ok((await old.instance.begin(now)).ok); await old.acknowledge();
    assert.equal(app.requests[0]?.voice, "coral");
    const session = app.sockets[0]!.sessions[0] as { audio: { input: { transcription: { model: string; languages: string[] } } } };
    assert.equal(session.audio.input.transcription.model, "gpt-live-transcribe");
    assert.deepEqual(session.audio.input.transcription.languages, ["en"]);
    assert.ok((await app.policy.changeVoiceSetting(app.scope, "2", kind, kind === "locale" ? "en-US" : "cedar", "owner")).ok);
    const future = app.call(); assert.ok((await future.instance.begin(now)).ok); await future.acknowledge();
    await availability(old);
    const oldSpeech = app.requests.at(-1)!;
    assert.equal(oldSpeech.voice, "coral"); assert.ok(oldSpeech.input.includes("4 October"));
    await availability(future);
    const newSpeech = app.requests.at(-1)!;
    assert.equal(newSpeech.voice, kind === "voiceId" ? "cedar" : "coral");
    assert.ok(newSpeech.input.includes(kind === "locale" ? "October 4" : "4 October"));
    const auditBefore = value(await app.policy.listVoiceChanges(app.scope)); assert.equal(auditBefore.entries.length, 3);
    assert.ok((await app.policy.changeVoiceSetting(app.scope, "3", kind, null, "owner")).ok);
    const sockets = app.sockets.length, requests = app.requests.length;
    const denied = await app.call().instance.begin(now); assert.ok(!denied.ok && denied.error.kind === "readinessFailed");
    assert.equal(app.sockets.length, sockets); assert.equal(app.requests.length, requests);
    // A later withdrawal affects future binding, not the already-created providers of an active call.
    app.approve(false); await availability(old);
    assert.equal(app.requests.at(-1)?.voice, "coral"); assert.ok(app.requests.at(-1)!.input.includes("4 October"));
    assert.ok((await old.instance.disconnect(now)).ok); assert.ok((await future.instance.disconnect(now)).ok);
    assert.ok(app.sockets.every(socket => socket.closed === 1));
    const state = value(await app.policy.read(app.scope)); assert.equal(state.voiceProfile, undefined);
    assert.equal(state.capabilities.book, "unavailable"); assert.equal(state.policyVersion, "0");
  });
}

test("E2E-258 E2E-259 physical hash runtime and quality version mismatches deny before opening any provider", async () => {
  const app = fixture({ runtime: { playbackOptions: { firstChunkDeadlineMs: 5_000 } } }); await configure(app);
  const profile = value(await app.policy.read(app.scope)).voiceProfile!;
  for (const changed of [{ ...profile, configurationHash: "0".repeat(64) }, { ...profile, qualityVersion: "foreign" },
    { ...profile, presentationVersion: "unknown" }, { ...profile, synthesisVersion: "unknown" },
    { ...profile, scope: { ...profile.scope, clinicId: "foreign" } }]) assert.equal(app.host.create(changed, "session", { playbackOptions: { firstChunkDeadlineMs: 5_000 } }).ok, false);
  const denied = await app.call().instance.begin(now); assert.ok(!denied.ok && denied.error.kind === "readinessFailed");
  assert.equal(app.sockets.length, 0); assert.equal(app.requests.length, 0); assert.equal(app.reads(), 0);
  app.quality("synthetic-quality.v2");
  assert.equal(app.host.create(profile, "session", { playbackOptions: { firstChunkDeadlineMs: 5_000 } }).ok, false);
  assert.equal(app.sockets.length, 0);
});
test("E2E-259 fallback compatibility is intersected and failed quality cannot become a ready complete pair", async () => {
  const app = fixture({ fallbackModel: "tts-1", runtime: { playbackOptions: { firstChunkDeadlineMs: 5_000 } } });
  const catalogue = value(await listVoiceOptions(app.host, voiceClinicScope(app.scope)));
  assert.equal(catalogue.voices.some(voice => voice.id === "cedar"), false);
  assert.ok(catalogue.voices.some(voice => voice.id === "coral"));
  assert.ok((await app.policy.changeVoiceSetting(app.scope, "0", "locale", "en-AU", "owner")).ok);
  assert.equal((await app.policy.changeVoiceSetting(app.scope, "1", "voiceId", "cedar", "owner")).ok, false);
  app.approve(false);
  assert.equal((await app.policy.changeVoiceSetting(app.scope, "1", "voiceId", "coral", "owner")).ok, false);
  assert.equal(value(await app.policy.read(app.scope)).voiceSettings?.version, "1");
  assert.equal((await captureVoiceProfile(app.host, voiceClinicScope(app.scope), { version: "2", locale: "en-AU", voiceId: "coral" })).ok, false);
  assert.equal(app.sockets.length, 0); assert.equal(app.requests.length, 0);
});

test("E2E-258 E2E-259 mixed clinic revisions across shared-number locations deny the initial reservation", async () => {
  const app = fixture(); await configure(app);
  const identity = { accountRef: "account", dialedNumber: "+6125550199", tenantId: app.scope.tenantId,
    clinicId: app.scope.clinicId, candidateLocationIds: ["first", "second"],
    candidateNames: [{ locationId: "first", spokenName: "First" }, { locationId: "second", spokenName: "Second" }], routeVersion: "route.v1" };
  let done: () => void = () => {}; const changed = new Promise<void>(resolve => { done = resolve; });
  const router = new ClinicPolicyRouter({ identifyCall: async () => ok(identity) }, { read: async scope => {
    if (scope.locationId === "first") {
      const before = await app.policy.read(scope);
      assert.ok((await app.policy.changeVoiceSetting(app.scope, "2", "voiceId", "cedar", "owner")).ok); done(); return before;
    }
    await changed; return app.policy.read(scope);
  } });
  const event = { key: { accountRef: identity.accountRef, providerCallRef: randomUUID() }, dialedNumber: identity.dialedNumber, receivedAt: now };
  const admission = new CallAdmissionService(app.ledger, router.resolve, () => now, async () => ok(true));
  const intake = new SharedNumberIntakeService(app.ledger, router, admission, () => now);
  assert.deepEqual(await intake.begin(event), { ok: false, error: { kind: "readinessFailed" } });
  assert.equal(value(await app.ledger.findPendingLocation(callIdFor(event.key))), null);
  assert.equal(value(await app.ledger.findAdmission(callIdFor(event.key))), null);
  assert.equal(app.sockets.length, 0); assert.equal(app.requests.length, 0); assert.equal(app.reads(), 0);
});

test("E2E-258 E2E-259 a captured shared-number profile survives ordinary clinic clear and a mismatched direct bind cannot replace it", async () => {
  const app = fixture(); await configure(app);
  const second = { ...app.scope, locationId: "second" };
  assert.equal(value(await app.policy.read(second)).automationEnabled, true);
  const number = "+6125550199", account = "shared-voice-account";
  const router = new ClinicPolicyRouter(new ReferenceNumberRoutingHost([
    { ...app.scope, accountRef: account, dialedNumber: number, spokenName: "First", routeVersion: "route.v1" },
    { ...second, accountRef: account, dialedNumber: number, spokenName: "Second", routeVersion: "route.v1" },
  ]), app.policy);
  const admission = new CallAdmissionService(app.ledger, router.resolve, () => now, async () => ok(true));
  const intake = new SharedNumberIntakeService(app.ledger, router, admission, () => now);
  const event = { key: { accountRef: account, providerCallRef: randomUUID() }, dialedNumber: number, receivedAt: now };
  const captured = value(await intake.begin(event)); assert.equal(captured.kind, "locationChoice");
  assert.equal(captured.pending.route.voiceProfile?.voiceId, "coral");
  const attached = value(await intake.attachSession(event, "session"));
  assert.ok((await app.policy.changeVoiceSetting(app.scope, "2", "voiceId", null, "owner")).ok);
  const current = value(await app.policy.read(second)); assert.equal(current.voiceProfile, undefined);
  assert.deepEqual(await app.ledger.bindPendingLocation(callIdFor(event.key), { ...current, numberRouteVersion: "route.v1" },
    "session", attached.sessionLease!.version, "wrong-profile", now), { ok: false, error: { kind: "scopeMismatch" } });
  const chosen = value(await intake.choose(event, { callId: callIdFor(event.key), sessionId: "session", turnId: "choice",
    text: "Second", quality: "clear", at: now }, "second", attached.sessionLease!.version));
  const state = value(await app.ledger.read(chosen.receipt.callId, second));
  assert.equal(state.policy.voiceProfile?.voiceId, "coral"); assert.equal(state.policy.voiceSettings?.version, "2");
  const denied = await intake.begin({ ...event, key: { ...event.key, providerCallRef: randomUUID() } });
  assert.ok(!denied.ok && denied.error.kind === "readinessFailed");
});
