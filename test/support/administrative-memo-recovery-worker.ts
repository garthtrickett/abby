import assert from "node:assert/strict";
import { classBookingMemoFixture } from "./class-booking-memo.ts";
import { bookingMemoSessionFixture } from "./booking-memo-session.ts";
import { appointmentChangeMemoFixture } from "./appointment-change-memo.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { PostgresOutboundEffectBarrier } from "../../src/storage/postgres-outbound-effect-barrier.ts";
import { AdministrativeMemoAuthentication, administrativeMemoActionRef } from "../../src/cliniko/administrative-memo.ts";
import { administrativeMemoRecordBinding } from "../../src/cliniko/administrative-memo-records.ts";
import { ClinikoAdministrativeMemoRecovery } from "../../src/standalone/cliniko-administrative-memo-recovery.ts";
import { ClinikoBookingMemoRecovery } from "../../src/standalone/cliniko-booking-memo-recovery.ts";
import type { BookingMemoRecoverySelection } from "../../src/standalone/cliniko-booking-memo-recovery.ts";
import type { LocationScope } from "../../src/core/model.ts";
import type { AdministrativeMemoRecoverySelection } from "../../src/standalone/cliniko-administrative-memo-recovery.ts";
import type { AdministrativeMemoHistoryAuthority, AdministrativeMemoHistoryResult } from "../../src/cliniko/administrative-memo-history.ts";

// Separate disposable child, no inherited caller objects or local cache. Its
// protected clinic inputs contain a native review/appointment selection, never
// a communication ID or an action root supplied by the stopped sender.
const input: { family: "class" | "individual" | "cancel" | "reschedule"; mode: "send" | "recover"; proxy: string; scope: LocationScope; settings?: {
  key: string; businessId: string; authorRef: string; policy: { version: string; digest: string }; now: string;
  selection: AdministrativeMemoRecoverySelection | BookingMemoRecoverySelection;
} } = JSON.parse(await new Promise<string>(resolve => { let text = "";
  process.stdin.on("data", part => { text += String(part); }); process.stdin.on("end", () => resolve(text)); }));
assert.ok(["class", "individual", "cancel", "reschedule"].includes(input.family));
const db = connectPostgres(process.env.DATABASE_URL!), apiKey = input.family === "class" ? "synthetic-class-au5" : "synthetic-session-au5";
const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 180 });
const notify = async (path: string, body: unknown) => {
  const response = await fetch(input.proxy + path, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 204);
};
const nativePort: typeof fetch = async (value, init) => {
  const url = new URL(String(value)); assert.equal(url.origin, "https://api.au5.cliniko.com");
  const response = await fetch(input.proxy + url.pathname + url.search, { ...init, redirect: "error" });
  // This synthetic transport maps the already checked native origin to the
  // loopback provider. Do not present its localhost URL as a real Cliniko
  // redirect. Keep the response status, headers and abortable body unchanged.
  return new Response(response.body, { status: response.status, headers: response.headers });
};
const mirror: (port: typeof fetch) => typeof fetch = port => async (value, init) => {
  // Preserve the actual fixture's played SAM/dispatch assertions and mirror
  // that same synthetic provider's row into its surviving parent store.
  const response = await port(value, init);
  const path = new URL(String(value)).pathname, method = init?.method ?? "GET";
  if (method === "POST" || method === "PATCH" || method === "GET" && /^\/v1\/individual_appointments\/[1-9][0-9]*$/.test(path)) {
    await notify("/mirror-native", { method, path, ...(response.status === 204 ? {} : { row: await response.clone().json() }) });
  }
  return response;
};
try {
  if (input.mode === "send" && input.family === "class") {
    const f = await classBookingMemoFixture({ scope: input.scope, admitted: true, realQuotaWait: true, budget,
      verificationBudget: new PostgresPatientVerificationBudget(db, input.scope),
      barrierFor: (scope, owner) => new PostgresOutboundEffectBarrier(db, scope, owner), memoFetchPort: nativePort,
      clinicalFetchAround: mirror });
    try {
      const native = f.classSessionConfig.memo!.native;
      await notify("/sender-ready", { folder: f.folder, key: f.key.toString("hex"), businessId: native.businessId,
        authorRef: native.authorRef, policy: native.policy, callId: f.callId, sessionId: f.sessionId });
      const action = await f.prepare(); await f.drainClinical();
      assert.equal((await f.state()).actions[action.key]!.status, "committed"); assert.equal(f.writes.length, 1);
      assert.equal(action.mutation.request.kind, "book");
      await notify("/clinical-finished", { now: native.clock!(), code: f.mail[0]!.code,
        proof: action.mutation.request.patient.verificationRef });
      // The parent kills this exact process after the memo POST is retained
      // (or deliberately not retained) but before it acknowledges any response.
      await new Promise<void>(() => {});
    } finally { await f.close(); }
  } else if (input.mode === "send" && input.family === "individual") {
    const f = await bookingMemoSessionFixture({ scope: input.scope, budget, verificationBudget: new PostgresPatientVerificationBudget(db, input.scope),
      barrierFor: (scope, owner) => new PostgresOutboundEffectBarrier(db, scope, owner), memoFetchPort: nativePort, clinicalFetchAround: mirror });
    try {
      await notify("/sender-ready", { folder: f.folder, key: f.key.toString("hex"), businessId: f.native.businessId,
        authorRef: f.native.authorRef, policy: f.native.policy, callId: f.callId, sessionId: f.sessionId });
      const proof = await f.prepare(); await f.drainClinical(); const action = Object.values((await f.state()).actions).at(-1)!;
      assert.equal(action.status, "committed"); assert.equal(f.posts, 1);
      await notify("/clinical-finished", { now: f.native.clock!(), code: f.mail[0]!.code, proof });
      await new Promise<void>(() => {});
    } finally { await f.close(); }
  } else if (input.mode === "send" && (input.family === "cancel" || input.family === "reschedule")) {
    const f = await appointmentChangeMemoFixture(input.family, { scope: input.scope, budget, verificationBudget: new PostgresPatientVerificationBudget(db, input.scope),
      barrierFor: (scope, owner) => new PostgresOutboundEffectBarrier(db, scope, owner), memoFetchPort: nativePort, clinicalFetchAround: mirror });
    try {
      await notify("/sender-ready", { folder: f.folder, key: f.key.toString("hex"), businessId: f.native.businessId,
        authorRef: f.native.authorRef, policy: f.native.policy, callId: f.callId, sessionId: f.sessionId });
      const proof = await f.prepare(); await f.drainClinical(); const action = Object.values((await f.state()).actions).at(-1)!;
      assert.equal(action.status, "committed"); assert.equal(f.patches, 1);
      await notify("/clinical-finished", { now: f.native.clock(), code: f.mail[0]!.code, proof });
      await new Promise<void>(() => {});
    } finally { await f.close(); }
  } else {
    const settings = input.settings!; assert.ok(settings);
    assert.deepEqual(Object.keys(settings.selection).sort(), input.family === "individual" ? ["appointmentRef", "createdFrom", "createdThrough", "patientId"] :
      ["createdFrom", "createdThrough", "patientId", "recallRef"]);
    const authentication = new AdministrativeMemoAuthentication(Buffer.from(settings.key, "hex"));
    const config = { scope: input.scope, apiKey, contactEmail: "ops@example.invalid", businessId: settings.businessId,
      authorRef: settings.authorRef, policy: settings.policy, rateBudget: budget, clock: () => settings.now, deadlineMs: 5000 };
    const history: AdministrativeMemoHistoryAuthority = {
      allowsHistoryRead: async query => query.collection === "patientMemoPhoneCommunications" && query.patientId === settings.selection.patientId,
      allowsRecordRead: async query => query.patientId === settings.selection.patientId && query.confidential === true, current: () => true };
    const selected = settings.selection;
    let found: AdministrativeMemoHistoryResult;
    if (input.family !== "individual" && "recallRef" in selected) {
      const service = resultValue(ClinikoAdministrativeMemoRecovery.create(config, authentication, "7",
        { allows: async query => query.patientId === selected.patientId && query.recallRef === selected.recallRef && query.includeArchived === true, current: () => true }, history, nativePort));
      found = resultValue(await service.recover(selected, new AbortController().signal));
    } else if (input.family === "individual" && "appointmentRef" in selected) {
      const service = resultValue(ClinikoBookingMemoRecovery.create(config, authentication,
        { allows: async query => query.patientId === selected.patientId && query.appointmentRef === selected.appointmentRef, current: () => true }, history, nativePort));
      found = resultValue(await service.recover(selected, new AbortController().signal));
    } else assert.fail("invalid native source selection");
    const owner = administrativeMemoRecordBinding(config, authentication)!;
    const spent = resultValue(await new PostgresOutboundEffectBarrier(db, input.scope, owner).claimOnce(administrativeMemoActionRef(found.selection.sourceActionRef)!));
    assert.equal(spent.claimed, false, "native absence and cold recovery must not recreate a consumed memo purpose");
    process.stdout.write(JSON.stringify({ kind: found.kind, scanned: found.scanned, spent: true, replayed: false }) + "\n");
  }
} finally { await db.destroy(); }
