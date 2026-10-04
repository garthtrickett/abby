import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClinikoRecallReader } from "../../src/cliniko/recalls.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ClinikoCancellationSession } from "../../src/standalone/cliniko-cancellation-session.ts";
import type { ClinikoCancellationSessionConfig } from "../../src/standalone/cliniko-cancellation-session.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import type { PatientCodeDelivery, PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import type { LocationScope } from "../../src/core/model.ts";
import type { CancellationApproval } from "../../src/standalone/owner-file-cancellation-policy.ts";
import { callerVerificationFixture, verificationCanaries, verificationNow } from "./caller-verification.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

/** Full trusted composition, synthetic clinical approval/permission/mail/provider. No live activation. */
export async function cancellationSessionFixture(options: { budget?: PatientVerificationBudget; rateBudget?: ClinikoRequestBudget;
  delivery?: PatientCodeDelivery; timeoutMs?: number; multiple?: boolean; lostRecall?: boolean; lostWrite?: boolean; scope?: LocationScope; fetchPort?: typeof fetch } = {}) {
  const f = await callerVerificationFixture({ operation: "appointments.cancel", cancellationExecute: true, ...(options.scope ? { scope: options.scope } : {}) });
  f.session.dispose();
  const lifetime = new AbortController(), apiKey = "synthetic-session-au5", base = "https://api.au5.cliniko.com/v1";
  const path = join(f.folder, "cancellation.json"), traffic: string[] = [], mail: { email: string; code: string }[] = [];
  let patches = 0, claims = 0, held = false, released: () => void = () => undefined;
  let onRecall: () => Promise<void> = async () => undefined;
  const cancelled = new Set<string>(), recalls: Record<string, unknown>[] = [];
  let record: CancellationApproval = { scope: f.scope, revision: "fee-approval-1", approverRef: "synthetic-admin",
    approvedAt: "2026-10-04T05:59:00.000Z", effectiveFrom: verificationNow, effectiveUntil: "2026-10-05T06:00:00.000Z",
    approved: true, enabled: true, policyVersion: f.sessionConfig.policyVersion, businessId: "11", recallTypeId: "7",
    credentialFingerprint: clinikoCredentialFingerprint(apiKey), timeZone: "Australia/Sydney", writeContract: "bestEffort",
    notificationOwner: "cliniko", cancellationReason: 50, lateNoticeHours: 24, maxAdvanceDays: 30,
    standardTerms: { version: "standard-1", approvedText: "There is no fee for this cancellation." },
    lateTerms: { version: "late-1", approvedText: "A cancellation fee of $20 applies." } };
  const replace = async () => { await writeFile(`${path}.new`, JSON.stringify(record), { mode: 0o600 }); await rename(`${path}.new`, path); };
  const target = (id: string) => ({ id, starts_at: id === "91" ? "2026-10-08T04:00:00.000Z" : "2026-10-08T05:00:00.000Z",
    ends_at: id === "91" ? "2026-10-08T04:30:00.000Z" : "2026-10-08T05:30:00.000Z", archived_at: null, deleted_at: null,
    cancelled_at: cancelled.has(id) ? verificationNow : null, notes: verificationCanaries[1],
    patient: { links: { self: `${base}/patients/${verificationCanaries[2]}` } }, business: { links: { self: `${base}/businesses/11` } },
    practitioner: { links: { self: `${base}/practitioners/22` } }, appointment_type: { links: { self: `${base}/appointment_types/33` } } });
  const fetchPort: typeof fetch = async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
    traffic.push(`${method} ${url.pathname}`);
    if (url.pathname.startsWith("/v1/patients/")) return Response.json({ id: verificationCanaries[2], email: verificationCanaries[0],
      archived_at: null, patient_phone_numbers: [{ number: "+61400111222", phone_type: "Mobile" }], notes: verificationCanaries[1] });
    if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", archived_at: null, time_zone_identifier: "Australia/Sydney" });
    if (url.pathname === "/v1/individual_appointments") {
      const appointments = [target("91"), ...(options.multiple ? [target("92")] : [])];
      return Response.json({ individual_appointments: appointments, total_entries: appointments.length });
    }
    if (url.pathname.startsWith("/v1/individual_appointments/") && method === "GET") {
      if (held) await new Promise<void>(resolve => { released = resolve; });
      return Response.json(target(url.pathname.split("/").at(-1)!));
    }
    if (url.pathname.endsWith("/cancel") && method === "PATCH") {
      patches++; assert.equal(recalls.length, 1); assert.equal(JSON.parse(String(init?.body)).cancellation_reason, 50);
      const action = Object.values((await f.state()).actions)[0]!;
      assert.equal(action.status, "dispatched"); assert.equal((await f.state()).presentations[action.presentationId]?.status, "played");
      cancelled.add(url.pathname.split("/").at(-2)!);
      if (options.lostWrite) throw new Error("synthetic lost mutation response");
      return new Response(null, { status: 204 });
    }
    assert.equal(url.pathname, "/v1/recalls");
    if (method === "GET") return Response.json({ recalls, total_entries: recalls.length });
    assert.equal(method, "POST"); const body = JSON.parse(String(init?.body));
    const row = { id: "71", archived_at: null, recalled: false, recall_at: body.recall_at, notes: body.notes,
      patient: { links: { self: `${base}/patients/${verificationCanaries[2]}` } }, recall_type: { links: { self: `${base}/recall_types/7` } } };
    recalls.push(row); await onRecall();
    if (options.lostRecall) throw new Error("synthetic lost recall response");
    return Response.json(row, { status: 201 });
  };
  let owner: ClinikoCancellationSession | undefined;
  try {
    await replace();
    const config: ClinikoCancellationSessionConfig = { receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId,
      policyVersion: f.sessionConfig.policyVersion, ledger: f.ledger, policies: f.policies, lookup: f.sessionConfig.lookup,
      permission: f.sessionConfig.permission, verificationBudget: options.budget ?? { reserve: async () => true },
      delivery: options.delivery ?? { send: async (email, code) => { mail.push({ email, code }); return true; } },
      directory: new OwnerFileAdminDirectory(f.accountPath, f.scope), callerApprovalPath: f.path, cancellationApprovalPath: path,
      cliniko: { apiKey, contactEmail: "test@example.test", businessId: "11", recallTypeId: "7", timeZone: "Australia/Sydney", countryCallingCode: "61",
        rateBudget: options.rateBudget ?? { claim: async () => { claims++; return null; }, observe429: async () => ({ kind: "rateLimited" }) } },
      signal: lifetime.signal, fetchPort: options.fetchPort ?? fetchPort, clock: f.sessionConfig.clock, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) };
    owner = resultValue(await ClinikoCancellationSession.create(config));
    const reception = new TextReception(f.ledger, f.policies, owner.effects, undefined, owner.appointments);
    const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope: f.scope }, f.policies, reception, undefined, undefined, undefined, f.ledger);
    const turn = (turnId: string, text = "Cancel my appointment") => ({ callId: f.callId, sessionId: f.sessionId, turnId, text, quality: "clear" as const, at: verificationNow });
    const read = (verificationRef: string) => agent.submit({ kind: "appointments.read.v1", turn: turn("list"),
      verificationRef, from: verificationNow, to: "2026-10-09T06:00:00.000Z", now: verificationNow });
    const propose = (verificationRef: string) => agent.submit({ kind: "appointments.change.propose.v1", turn: turn("proposal"),
      selection: { kind: "cancel", verificationRef, targetRef: "selected" }, now: verificationNow });
    async function playPending() {
      const presentation = (await f.state()).pendingPresentationId!; assert.ok(presentation);
      resultValue(await f.runtime.startPresentation(f.callId, presentation, f.sessionId, verificationNow));
      resultValue(await f.runtime.resolvePresentation(f.callId, presentation, "played", f.sessionId, verificationNow));
    }
    async function confirm() {
      await playPending(); const action = Object.values((await f.state()).actions)[0]!;
      resultValue(await reception.affirm(f.scope, turn("affirm", "Yes"), action.key, action.digest, verificationNow));
    }
    return { ...f, owner, lifetime, config, traffic, mail, recalls, read, propose, reception, agent, turn, playPending, confirm,
      drain: () => reception.drain(f.scope, f.callId, verificationNow),
      discovery: async () => resultValue(await resultValue(ClinikoRecallReader.create({ ...config.cliniko, scope: f.scope }, fetchPort)).discoverPendingReviews(f.scope, "7")),
      get patches() { return patches; }, get claims() { return claims; },
      replaceCancellation: async (patch: Partial<CancellationApproval>) => { record = { ...record, ...patch }; await replace(); },
      setOnRecall: (run: () => Promise<void>) => { onRecall = run; }, setHold: () => { held = true; }, release: () => released(),
      close: async () => { lifetime.abort(); owner?.dispose(); released(); await f.close(); } };
  } catch (error) { lifetime.abort(); owner?.dispose(); await f.close(); throw error; }
}
