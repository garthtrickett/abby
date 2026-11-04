import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { chmod, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { err, ok } from "../../src/core/model.ts";
import { proposeClinicVocabulary, reviewClinicVocabulary, vocabularyRevision } from "../../src/core/clinic-vocabulary.ts";
import type { PublicVocabularyCatalogue } from "../../src/core/clinic-vocabulary.ts";
import { captureVoiceProfile } from "../../src/core/voice-profile-registry.ts";
import { OwnerFileClinicVocabulary } from "../../src/standalone/owner-file-clinic-vocabulary.ts";
import type { ClinicVocabularyApproval, PublicVocabularyCatalogueReader } from "../../src/standalone/owner-file-clinic-vocabulary.ts";
import type { AdminAccount, AdminDirectory } from "../../src/standalone/identity/magic-link.ts";
import { ClinicVocabularyReview } from "../../src/standalone/clinic-vocabulary-review.ts";
import { ApprovedCatalogueVocabulary } from "../../src/standalone/approved-catalogue-vocabulary.ts";
import { OwnerFileServiceCatalogue } from "../../src/standalone/owner-file-service-catalogue.ts";
import type { ServiceCatalogueApproval } from "../../src/standalone/owner-file-service-catalogue.ts";
import { OpenAIVoiceProfileHost } from "../../src/voice/openai-voice-profile.ts";
import { bindReviewedDeepgramVocabulary } from "../../src/voice/reviewed-deepgram-transcription.ts";
import type { MediaFrame } from "../../src/voice/media-turn-controller.ts";

const signal = () => AbortSignal.timeout(5_000);
const scope = { tenantId: "synthetic", clinicId: "main", locationId: "north" };
const frame = (sessionId: string): MediaFrame => ({ sessionId, sequence: 0,
  capturedAt: "2026-11-04T00:00:00.000Z", bytes: new Uint8Array(640).fill(12) });
class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: (string | Buffer)[] = [];
  terminated = 0;
  open() { this.readyState = WebSocket.OPEN; this.emit("open"); }
  send(value: string | Buffer) { this.sent.push(value); this.emit("sent"); }
  receive(value: object) { this.emit("message", Buffer.from(JSON.stringify(value)), false); }
  terminate() { this.terminated++; this.readyState = WebSocket.CLOSED; }
  end() { this.readyState = WebSocket.CLOSED; this.emit("close", 1000); }
}
async function closeRequested(socket: Socket) {
  const signal = AbortSignal.timeout(5_000);
  while (!socket.sent.includes('{"type":"CloseStream"}')) await once(socket, "sent", { signal });
}
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "abby-vocabulary-"));
  const path = join(folder, "public-vocabulary.json");
  let inventory: PublicVocabularyCatalogue = { scope, version: "inventory.v1", complete: true,
    items: [{ ref: "service", kind: "service", publicText: "Physiotherapy" },
      { ref: "unapproved", kind: "practitioner", publicText: "Unpublished Person" }], approvedPublicRefs: ["service"] };
  const proposal = proposeClinicVocabulary(inventory); assert.ok(proposal.ok);
  const reviewed = reviewClinicVocabulary(inventory, undefined, { ...proposal.value,
    manualPublicTerms: [], selectedTerms: proposal.value.suggestions });
  // The review input schema deliberately does not accept an echoed whole proposal.
  assert.equal(reviewed.ok, false);
  const saved = reviewClinicVocabulary(inventory, undefined, { expectedRevision: proposal.value.expectedRevision,
    catalogueHash: proposal.value.catalogueHash, manualPublicTerms: [], selectedTerms: proposal.value.suggestions });
  assert.ok(saved.ok);
  let row: ClinicVocabularyApproval = { scope, revision: "approval.v1", approverRef: "admin",
    approvedAt: "2026-11-03T00:00:00.000Z", effectiveFrom: "2026-11-03T00:00:00.000Z",
    effectiveUntil: "2026-11-05T00:00:00.000Z", approved: true, enabled: true, vocabulary: saved.value };
  let member: AdminAccount | undefined = { email: "synthetic@example.test", membershipVersion: "membership.v1",
    actor: { actorRef: "admin", role: "clinicAdmin", scope } };
  let onInventory: (() => Promise<void>) | undefined;
  const directory: AdminDirectory = { async findByRef() { return ok(member); }, async findByEmail() { return ok(member); } };
  const catalogue: PublicVocabularyCatalogueReader = { async current() {
    await onInventory?.(); return ok(structuredClone(inventory));
  } };
  const replace = async (patch: Partial<ClinicVocabularyApproval>) => {
    row = { ...row, ...patch }; await writeFile(path + ".next", JSON.stringify(row), { mode: 0o600 });
    await rename(path + ".next", path);
  };
  await replace({});
  const config = { path, scope, directory, catalogue, clock: () => "2026-11-04T00:00:00.000Z" };
  return { path, config, replace, get row() { return structuredClone(row); },
    changeInventory(value: PublicVocabularyCatalogue) { inventory = value; },
    get inventory() { return structuredClone(inventory); }, revoke() { member = undefined; },
    duringInventory(action: () => Promise<void>) { onInventory = action; },
    async close() { await rm(folder, { recursive: true, force: true }); } };
}

test("reviewed owner vocabulary reaches actual Nova-3 requests and exact profile identity without granting speech quality", async () => {
  const f = await fixture(), sockets: Socket[] = [], requests: URL[] = [];
  try {
    const captured = await OwnerFileClinicVocabulary.capture(f.config); assert.ok(captured.ok);
    const factory = await bindReviewedDeepgramVocabulary(captured.value, { apiKey: "synthetic-key", socketFactory(raw) {
      requests.push(new URL(raw)); const socket = new Socket(); sockets.push(socket); queueMicrotask(() => socket.open()); return socket as unknown as WebSocket;
    } }, signal()); assert.ok(factory.ok);
    const settings = { version: "1", locale: "en-AU", voiceId: "coral" };
    const unproven = new OpenAIVoiceProfileHost({ apiKey: "synthetic", mode: "conversation", customTranscription: factory.value });
    assert.equal((await captureVoiceProfile(unproven, { tenantId: scope.tenantId, clinicId: scope.clinicId }, settings)).ok, false);
    assert.equal(requests.length, 0);
    const host = new OpenAIVoiceProfileHost({ apiKey: "synthetic", mode: "conversation", customTranscription: factory.value,
      quality: (_scope, configurationHash) => ok({ configurationHash, qualityVersion: "synthetic-only" }) });
    const selected = await captureVoiceProfile(host, { tenantId: scope.tenantId, clinicId: scope.clinicId }, settings); assert.ok(selected.ok);
    assert.equal((await host.resolve({ tenantId: scope.tenantId, clinicId: "another-clinic" })).ok, false);
    assert.equal(host.create({ ...selected.value, scope: { tenantId: "other", clinicId: scope.clinicId } }, "wrong-clinic", {}).ok, false);
    const bound = host.create(selected.value, "call-one", {}); assert.ok(bound.ok);
    try {
      assert.ok((await bound.value.transcription.accept(frame("call-one"), 1, signal())).ok);
      assert.deepEqual(requests[0]!.searchParams.getAll("keyterm"), ["Physiotherapy"]);
      assert.equal(requests[0]!.searchParams.get("model"), "nova-3");
      const pending = bound.value.transcription.flush(1, signal());
      await closeRequested(sockets[0]!);
      sockets[0]!.receive({ type: "Results", channel_index: [0, 1], start: 0, duration: 0.02, is_final: true,
        speech_final: true, channel: { alternatives: [{ transcript: "Physiotherapy", confidence: 1 }] } });
      sockets[0]!.receive({ type: "Metadata", channels: 1, duration: 0.02 }); sockets[0]!.end();
      const result = await pending; assert.ok(result.ok); assert.equal(result.value[0]?.text, "Physiotherapy");
    } finally { await bound.value.transcription.close?.(); }
    await f.replace({ revision: "approval.v2" });
    const recaptured = await OwnerFileClinicVocabulary.capture(f.config); assert.ok(recaptured.ok);
    const changed = await bindReviewedDeepgramVocabulary(recaptured.value, { apiKey: "synthetic-key" }, signal()); assert.ok(changed.ok);
    assert.notEqual(changed.value.version, factory.value.version);
    const second = new OpenAIVoiceProfileHost({ apiKey: "synthetic", mode: "conversation", customTranscription: changed.value,
      quality: (_scope, configurationHash) => configurationHash === selected.value.configurationHash
        ? ok({ configurationHash, qualityVersion: "synthetic-only" }) : err({ kind: "readinessFailed", missing: ["voiceProfile"] }) });
    assert.equal(second.create(selected.value, "stale-quality", {}).ok, false);
  } finally { await f.close(); }
});

test("approval, membership, source or permissions changes block audio before a provider socket opens", async () => {
  for (const scenario of ["approval", "membership", "catalogue", "incomplete", "publicRefs", "permissions"] as const) {
    const f = await fixture(); let sockets = 0;
    try {
      const captured = await OwnerFileClinicVocabulary.capture(f.config); assert.ok(captured.ok);
      const factory = await bindReviewedDeepgramVocabulary(captured.value, { apiKey: "synthetic-key", socketFactory() {
        sockets++; const socket = new Socket(); queueMicrotask(() => socket.open()); return socket as unknown as WebSocket;
      } }, signal()); assert.ok(factory.ok);
      const port = factory.value.create("call");
      if (scenario === "approval") await f.replace({ enabled: false });
      if (scenario === "membership") f.revoke();
      if (scenario === "catalogue") f.changeInventory({ ...f.inventory, version: "new" });
      if (scenario === "incomplete") f.changeInventory({ ...f.inventory, complete: false } as unknown as PublicVocabularyCatalogue);
      if (scenario === "publicRefs") f.changeInventory({ ...f.inventory, approvedPublicRefs: [] });
      if (scenario === "permissions") await chmod(f.path, 0o644);
      assert.equal((await port.accept(frame("call"), 1, signal())).ok, false, scenario);
      assert.equal(sockets, 0, scenario); await port.close?.();
      assert.equal((await OwnerFileClinicVocabulary.capture(f.config)).ok, false, scenario);
    } finally { await f.close(); }
  }
});

test("an approval replaced during catalogue lookup cannot authorize a stale dictionary", async () => {
  const f = await fixture();
  try {
    f.duringInventory(async () => { await f.replace({ approved: false }); });
    assert.equal((await OwnerFileClinicVocabulary.capture(f.config)).ok, false);
  } finally { await f.close(); }
});

test("vocabulary revocation while Nova-3 flushes discards the transcript and closes only that call", async () => {
  const f = await fixture(), sockets: Socket[] = [];
  try {
    const captured = await OwnerFileClinicVocabulary.capture(f.config); assert.ok(captured.ok);
    const factory = await bindReviewedDeepgramVocabulary(captured.value, { apiKey: "synthetic-key", socketFactory() {
      const socket = new Socket(); sockets.push(socket); queueMicrotask(() => socket.open()); return socket as unknown as WebSocket;
    } }, signal()); assert.ok(factory.ok);
    const port = factory.value.create("one"), other = factory.value.create("two");
    try {
      assert.ok((await port.accept(frame("one"), 1, signal())).ok);
      assert.ok((await other.accept(frame("two"), 1, signal())).ok);
      const pending = port.flush(1, signal());
      await closeRequested(sockets[0]!);
      await f.replace({ enabled: false });
      sockets[0]!.receive({ type: "Results", channel_index: [0, 1], start: 0, duration: 0.02, is_final: true,
        speech_final: true, channel: { alternatives: [{ transcript: "STALE RESULT", confidence: 1 }] } });
      sockets[0]!.receive({ type: "Metadata", channels: 1, duration: 0.02 }); sockets[0]!.end();
      assert.equal((await pending).ok, false);
      assert.equal(sockets[1]!.terminated, 0);
      assert.equal((await other.flush(1, signal())).ok, false);
      assert.equal(sockets[1]!.terminated, 1);
    } finally { await port.close?.(); await other.close?.(); }
  } finally { await f.close(); }
});

const actor = { actorRef: "admin", role: "clinicAdmin" as const, scope };
test("owner review persists manual edits and removals and rejects stale saves after a catalogue refresh", async () => {
  const f = await fixture();
  try {
    const editor = new ClinicVocabularyReview(f.config), first = await editor.propose(actor, signal()); assert.ok(first.ok);
    const input = { expectedBinding: first.value.expectedBinding, expectedRevision: first.value.expectedRevision,
      catalogueHash: first.value.catalogueHash, manualPublicTerms: ["Published clinic alias"], selectedTerms: [] };
    const saved = await editor.save(actor, input, signal()); assert.ok(saved.ok);
    assert.deepEqual(saved.value.removedTerms, ["Physiotherapy"]);
    const persisted = JSON.parse(await readFile(f.path, "utf8")) as ClinicVocabularyApproval;
    assert.deepEqual(persisted.vocabulary, saved.value);
    const before = await readFile(f.path, "utf8");
    assert.equal((await editor.save(actor, input, signal())).ok, false);
    assert.equal(await readFile(f.path, "utf8"), before);
    f.changeInventory({ ...f.inventory, version: "inventory.v2", approvedPublicRefs: ["service", "new-service"],
      items: [...f.inventory.items, { ref: "new-service", kind: "service", publicText: "Sports rehabilitation" }] });
    assert.equal((await OwnerFileClinicVocabulary.capture(f.config)).ok, false, "changed catalogue cannot be spoken before review");
    const nextEditor = new ClinicVocabularyReview(f.config), next = await nextEditor.propose(actor, signal()); assert.ok(next.ok);
    assert.deepEqual(next.value.manualTerms, ["Published clinic alias"]);
    assert.deepEqual(next.value.suggestions, ["Sports rehabilitation"]);
    const accepted = await nextEditor.save(actor, { expectedBinding: next.value.expectedBinding,
      expectedRevision: next.value.expectedRevision, catalogueHash: next.value.catalogueHash,
      manualPublicTerms: next.value.manualTerms, selectedTerms: next.value.suggestions }, signal()); assert.ok(accepted.ok);
    assert.deepEqual(accepted.value.removedTerms, ["Physiotherapy"]);
    const bound = await OwnerFileClinicVocabulary.capture(f.config); assert.ok(bound.ok);
    assert.deepEqual(await bound.value.current(signal()), ok(["Published clinic alias", "Sports rehabilitation"]));
    assert.equal((await nextEditor.propose({ ...actor, role: "staff" }, signal())).ok, false);
    assert.equal((await nextEditor.propose({ ...actor, scope: { ...scope, clinicId: "other" } }, signal())).ok, false);
  } finally { await f.close(); }
});

test("competing vocabulary writers cannot overwrite an accepted owner review or leave temporary files", async () => {
  const f = await fixture();
  try {
    const editor = new ClinicVocabularyReview(f.config), first = await editor.propose(actor, signal()); assert.ok(first.ok);
    const input = { expectedBinding: first.value.expectedBinding, expectedRevision: first.value.expectedRevision,
      catalogueHash: first.value.catalogueHash, manualPublicTerms: ["Public winner one"], selectedTerms: [] };
    const outcomes = await Promise.all([editor.save(actor, input, signal()),
      new ClinicVocabularyReview(f.config).save(actor, { ...input, manualPublicTerms: ["Public winner two"] }, signal())]);
    assert.equal(outcomes.filter(result => result.ok).length, 1);
    const winner = outcomes.find(result => result.ok); assert.ok(winner?.ok);
    const row = JSON.parse(await readFile(f.path, "utf8")) as ClinicVocabularyApproval;
    assert.deepEqual(row.vocabulary, winner.value);
    assert.equal(Number(row.vocabulary.version), Number(f.row.vocabulary.version) + 1);
    assert.deepEqual(await readdir(join(f.path, "..")), ["public-vocabulary.json"]);
  } finally { await f.close(); }
});

test("a catalogue change during review commit refuses the save and preserves the existing approval", async () => {
  const f = await fixture();
  try {
    const editor = new ClinicVocabularyReview(f.config), first = await editor.propose(actor, signal()); assert.ok(first.ok);
    const original = await readFile(f.path, "utf8"); let reads = 0;
    f.duringInventory(async () => { if (++reads === 3) f.changeInventory({ ...f.inventory, version: "changed-during-commit" }); });
    const result = await editor.save(actor, { expectedBinding: first.value.expectedBinding,
      expectedRevision: first.value.expectedRevision, catalogueHash: first.value.catalogueHash,
      manualPublicTerms: ["Explicit public edit"], selectedTerms: [] }, signal());
    assert.equal(result.ok, false); assert.equal(reads, 3);
    assert.equal(await readFile(f.path, "utf8"), original);
    assert.deepEqual(await readdir(join(f.path, "..")), ["public-vocabulary.json"]);
  } finally { await f.close(); }
});

test("real approved booking catalogue needs separate exact public-field approval before vocabulary extraction", async () => {
  const f = await fixture();
  try {
    const cataloguePath = join(f.path, "..", "booking-catalogue.json"), publicationPath = join(f.path, "..", "publication.json");
    const { vocabulary: _vocabulary, ...approval } = f.row;
    const binding = { scope, policyVersion: "policy-v1", businessId: "1", credentialFingerprint: "a".repeat(64), timeZone: "Australia/Sydney" };
    const row: ServiceCatalogueApproval = { ...approval, ...binding, locationName: "Published North Clinic", eligibilityBasis: "callerAttestation",
      services: [{ serviceRef: "physio", name: "Physiotherapy", appointmentTypeName: "Private booking label", appointmentTypeId: "2",
        durationMinutes: 30, visitKind: "initial", searchDays: 7, followUpRule: null,
        practitioners: [{ practitionerId: "3", name: "Unpublished Clinician" }] }] };
    await writeFile(cataloguePath, JSON.stringify(row), { mode: 0o600 });
    const captureCatalogue = () => OwnerFileServiceCatalogue.capture({ ...binding, path: cataloguePath,
      directory: f.config.directory, clock: f.config.clock });
    const captured = await captureCatalogue(); assert.ok(captured.ok);
    const publication = { ...approval, catalogueBinding: captured.value.bindingFingerprint(), publicRefs: ["service:physio", "location:north"] };
    await writeFile(publicationPath, JSON.stringify(publication), { mode: 0o600 });
    const reader = new ApprovedCatalogueVocabulary({ path: publicationPath, scope, directory: f.config.directory,
      clock: f.config.clock, captureCatalogue });
    const found = await reader.current(scope, signal()); assert.ok(found.ok);
    const proposed = proposeClinicVocabulary(found.value); assert.ok(proposed.ok);
    assert.deepEqual(proposed.value.suggestions, ["Published North Clinic", "Physiotherapy"]);
    assert.equal(proposed.value.suggestions.includes("Unpublished Clinician"), false);
    assert.equal(proposed.value.suggestions.includes("Private booking label"), false);
    await writeFile(cataloguePath, JSON.stringify({ ...row, locationName: "Changed without new publication approval" }), { mode: 0o600 });
    assert.equal((await reader.current(scope, signal())).ok, false);
    await writeFile(cataloguePath, JSON.stringify(row), { mode: 0o600 });
    await writeFile(publicationPath, JSON.stringify({ ...publication, publicRefs: ["missing"] }), { mode: 0o600 });
    assert.equal((await reader.current(scope, signal())).ok, false);
    await writeFile(publicationPath, JSON.stringify(publication), { mode: 0o600 }); f.revoke();
    assert.equal((await reader.current(scope, signal())).ok, false);
  } finally { await f.close(); }
});

test("invalid Nova-3 credentials cannot advertise a reviewed factory or open a socket", async () => {
  const f = await fixture(); let sockets = 0;
  try {
    const captured = await OwnerFileClinicVocabulary.capture(f.config); assert.ok(captured.ok);
    for (const apiKey of ["", "with space", "\nsecret"]) {
      const bound = await bindReviewedDeepgramVocabulary(captured.value, { apiKey, socketFactory() {
        sockets++; return new Socket() as unknown as WebSocket;
      } }, signal());
      assert.equal(bound.ok, false);
    }
    assert.equal(sockets, 0);
  } finally { await f.close(); }
});

test("cancelling while vocabulary approval is pending cannot open a late provider stream", async () => {
  let reads = 0, sockets = 0;
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const factory = await bindReviewedDeepgramVocabulary({ version: "a".repeat(64), scope,
    async current() { if (++reads === 2) { entered(); await held; } return ok(["Physiotherapy"]); }
  }, { apiKey: "synthetic-key", socketFactory() {
    sockets++; const socket = new Socket(); queueMicrotask(() => socket.open()); return socket as unknown as WebSocket;
  } }, signal()); assert.ok(factory.ok);
  const port = factory.value.create("cancelled-call");
  try {
    const pending = port.accept(frame("cancelled-call"), 1, signal());
    await reading; await port.cancel?.(1); release();
    assert.equal((await pending).ok, false);
    assert.equal(sockets, 0);
    assert.ok((await port.accept(frame("cancelled-call"), 2, signal())).ok);
    assert.equal(sockets, 1, "a later generation keeps its independent admission");
  } finally { release(); await port.close?.(); }
});

test("actual emitted vocabulary factory and voice profile consume reviewed terms and reject revoked context", async () => {
  const { bindReviewedDeepgramVocabulary: bind } = await import(new URL(
    "../../dist/runtime/src/voice/reviewed-deepgram-transcription.js", import.meta.url).href) as
    typeof import("../../src/voice/reviewed-deepgram-transcription.ts");
  const { OpenAIVoiceProfileHost: Host } = await import(new URL(
    "../../dist/runtime/src/voice/openai-voice-profile.js", import.meta.url).href) as
    typeof import("../../src/voice/openai-voice-profile.ts");
  let current = true, socket: Socket | undefined, request: URL | undefined;
  const factory = await bind({ version: "b".repeat(64), scope, async current() {
    return current ? ok(["Published clinic term"]) : err({ kind: "unavailable" });
  } }, { apiKey: "synthetic-key", socketFactory(raw) {
    request = new URL(raw); socket = new Socket(); queueMicrotask(() => socket!.open()); return socket as unknown as WebSocket;
  } }, signal()); assert.ok(factory.ok);
  const host = new Host({ apiKey: "synthetic-key", mode: "conversation", customTranscription: factory.value,
    quality: (_scope, configurationHash) => ok({ configurationHash, qualityVersion: "synthetic-only" }) });
  assert.equal((await host.resolve({ tenantId: scope.tenantId, clinicId: "other-clinic" })).ok, false);
  const selected = await captureVoiceProfile(host, { tenantId: scope.tenantId, clinicId: scope.clinicId },
    { version: "1", locale: "en-AU", voiceId: "coral" }); assert.ok(selected.ok);
  const bound = host.create(selected.value, "emitted-call", {}); assert.ok(bound.ok);
  try {
    assert.ok((await bound.value.transcription.accept(frame("emitted-call"), 1, signal())).ok);
    assert.deepEqual(request!.searchParams.getAll("keyterm"), ["Published clinic term"]);
    assert.equal(Buffer.isBuffer(socket!.sent[0]), true);
    current = false;
    assert.equal((await bound.value.transcription.flush(1, signal())).ok, false);
    assert.equal(socket!.terminated, 1);
  } finally { await bound.value.transcription.close?.(); }
});

test("a provisioned owner approval cannot send a selected unpublished field to transcription", async () => {
  const f = await fixture();
  try {
    const draft = { ...f.row.vocabulary, selectedTerms: ["Unpublished Person"] };
    await f.replace({ vocabulary: { ...draft, revision: vocabularyRevision(draft) } });
    assert.equal((await OwnerFileClinicVocabulary.capture(f.config)).ok, false);
    const { OwnerFileClinicVocabulary: Emitted } = await import(new URL(
      "../../dist/runtime/src/standalone/owner-file-clinic-vocabulary.js", import.meta.url).href) as
      typeof import("../../src/standalone/owner-file-clinic-vocabulary.ts");
    assert.equal((await Emitted.capture(f.config)).ok, false);
    const editor = new ClinicVocabularyReview(f.config), proposal = await editor.propose(actor, signal());
    assert.ok(proposal.ok, "the current owner can repair a malformed selection without activating it");
    assert.equal(proposal.value.selectedTerms.includes("Unpublished Person"), false);
    assert.deepEqual(proposal.value.suggestions, ["Physiotherapy"]);
  } finally { await f.close(); }
});
