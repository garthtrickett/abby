import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CallRuntime } from "../../src/core/runtime.ts";
import { ok } from "../../src/core/model.ts";
import type { CallPolicy, LocationScope } from "../../src/core/model.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { ClinikoIntakeSession } from "../../src/standalone/cliniko-intake-session.ts";
import type { ClinikoIntakeSessionConfig } from "../../src/standalone/cliniko-intake-session.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import type { PatientVerificationBudget } from "../../src/standalone/email-patient-authority.ts";
import { approvedSyntheticPolicy } from "./approved-voice.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { intakePolicyFixture } from "./intake-policy.ts";
import { intakeCredential, intakeDraft, intakeNow } from "./intake-edge.ts";

export async function intakeSessionFixture(options: { rateBudget?: ClinikoRequestBudget; verificationBudget?: PatientVerificationBudget; timeoutMs?: number; fetchPort?: typeof fetch; folder?: string; bookingExecute?: boolean } = {}) {
  const f = await intakePolicyFixture(options.folder), scope = f.scope;
  let now = intakeNow, allowed = true, played = true, posts = 0, claims = 0, candidates = 0, loss = false, readMismatch = false;
  let mailAccepted = true, row: Record<string, unknown> | undefined;
  let onMail: () => Promise<void> = async () => undefined, onSearch: () => Promise<void> = async () => undefined, onPost: () => Promise<void> = async () => undefined, onRead: () => Promise<void> = async () => undefined;
  let onPermission: () => Promise<void> = async () => undefined, onPlay: () => Promise<void> = async () => undefined;
  let current: CallPolicy = approvedSyntheticPolicy({ ...referenceDefaultPolicy(scope), policyVersion: "policy-1", automationEnabled: true,
    firstTimeIntakeEnabled: true, firstTimeIntakeVersion: "1", capabilities: { book: options.bookingExecute ? "execute" : "unavailable", cancel: "unavailable", reschedule: "unavailable", intake: "execute", transfer: "unavailable" }, staffWorkEnabled: options.bookingExecute === true, bookingEnabled: options.bookingExecute === true });
  class Policies extends MemoryPolicyStore {
    override async read(bound: LocationScope) {
      return ok(structuredClone({ ...current, scope: bound }));
    }
  }
  const policies = new Policies("requestOnly", () => now), ledger = new MemoryLedger(async () => ok(true));
  const inbound = { key: { accountRef: "synthetic-intake-account", providerCallRef: `provider-${randomUUID()}` }, dialedNumber: "+6125550199", presentedCallerNumber: intakeDraft.patientPhone, receivedAt: now };
  const callId = callIdFor(inbound.key), sessionId = `session-${randomUUID()}`, runtime = new CallRuntime(ledger, scope);
  resultValue(await runtime.admit(callId, current, { key: inbound.key, dialedNumber: inbound.dialedNumber, acceptedAt: now, deadline: new Date(Date.parse(now)+30_000).toISOString() }));
  resultValue(await runtime.activate(callId, sessionId, now));
  const receipt = resultValue(await ledger.findAdmission(callId))!;
  const state = async () => resultValue(await ledger.read(callId, scope));
  const initial = (await state()).pendingPresentationId!;
  resultValue(await runtime.startPresentation(callId, initial, sessionId, now));
  resultValue(await runtime.resolvePresentation(callId, initial, "played", sessionId, now));
  const mail: { email: string; code: string }[] = [], presented: string[] = [], traffic: string[] = [], permissionDrafts: unknown[] = [];
  const fetchPort: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET"; traffic.push(`${method} ${url.pathname}`);
    assert.equal(url.origin, "https://api.au5.cliniko.com"); assert.equal(init?.redirect, "error");
    if (url.pathname === "/v1/patients" && method === "GET") {
      await onSearch();
      return Response.json({ total_entries: candidates, patients: Array.from({ length: candidates }, (_, index) => ({ id: String(index+101), archived_at: null })) });
    }
    if (url.pathname === "/v1/patients" && method === "POST") {
      posts++; const body = JSON.parse(String(init?.body)); row = { ...body, id: "42", archived_at: null, notes: "private intake provider notes" };
      await onPost(); if (loss) throw new Error("lost provider response"); return Response.json(row, { status: 201 });
    }
    assert.equal(url.pathname, "/v1/patients/42"); await onRead();
    return Response.json(readMismatch ? { ...row, email: "someone-else@example.test" } : row);
  };
  const lifetime = new AbortController();
  const config: ClinikoIntakeSessionConfig = { receipt, inbound, sessionId, policyVersion: "policy-1", ledger, policies, policy: f.policy,
    permission: { allows: async input => { permissionDrafts.push(structuredClone(input.draft)); await onPermission(); return allowed; } },
    verificationBudget: options.verificationBudget ?? { reserve: async () => true },
    delivery: { send: async (email, code) => { mail.push({ email, code }); await onMail(); return mailAccepted; } },
    presentation: { play: async text => { presented.push(text); await onPlay(); return played; } },
    cliniko: { apiKey: intakeCredential, contactEmail: "owner@example.test", rateBudget: options.rateBudget ?? { claim: async () => { claims++; return null; }, observe429: async () => ({ kind: "rateLimited" }) } },
    signal: lifetime.signal, fetchPort: options.fetchPort ?? fetchPort, clock: () => now, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) };
  let owner: ClinikoIntakeSession | undefined;
  try {
    owner = resultValue(await ClinikoIntakeSession.create(config));
    const reception = new TextReception(ledger, policies, owner);
    const agent = new CommandGateway({ actorRef: "trusted-agent", role: "agent", scope }, policies, reception, undefined, undefined, undefined, ledger);
    const turn = (turnId: string, text = "Register my reviewed details") => ({ callId, sessionId, turnId, text, quality: "clear" as const, at: now });
    async function prepare() {
      const begun = resultValue(await owner!.begin()); assert.equal(await owner!.acknowledgeRecovery(begun.recoveryRef, true), true);
      const draft = resultValue(await owner!.collect(intakeDraft, { privacyAccepted: true, intakeAccepted: true }));
      assert.ok(mail.at(-1)); assert.equal((await owner!.submitCode(mail.at(-1)!.code)).verified, true); return draft.draftRef;
    }
    const propose = (draftRef: string, turnId = "proposal") => agent.submit({ kind: "patients.intake.propose.v1", turn: turn(turnId), draftRef, now });
    async function confirm(play = true) {
      const action = Object.values((await state()).actions).at(-1)!; assert.ok(action);
      if (play) { resultValue(await runtime.startPresentation(callId, action.presentationId, sessionId, now)); resultValue(await runtime.resolvePresentation(callId, action.presentationId, "played", sessionId, now)); }
      return reception.affirm(scope, turn("affirm", "Yes"), action.key, action.digest, now);
    }
    return { ...f, scope, ledger, policies, runtime, receipt, inbound, callId, sessionId, owner, config, lifetime, mail, presented, traffic, permissionDrafts, state, reception, agent, turn, prepare, propose, confirm,
      drain: () => reception.drain(scope, callId, now), get posts() { return posts; }, get claims() { return claims; }, get row() { return row; },
      setTime: (value: string) => { now = value; f.setTime(value); }, setAllowed: (value: boolean) => { allowed = value; }, setPlayed: (value: boolean) => { played = value; },
      setCandidates: (value: number) => { candidates = value; }, setLoss: () => { loss = true; }, setReadMismatch: () => { readMismatch = true; }, setMailAccepted: (value: boolean) => { mailAccepted = value; },
      changeCurrent: (patch: Partial<CallPolicy>) => { current = { ...current, ...patch }; },
      onMail: (run: () => Promise<void>) => { onMail = run; }, onSearch: (run: () => Promise<void>) => { onSearch = run; }, onPost: (run: () => Promise<void>) => { onPost = run; },
      onRead: (run: () => Promise<void>) => { onRead = run; }, onPermission: (run: () => Promise<void>) => { onPermission = run; }, onPlay: (run: () => Promise<void>) => { onPlay = run; },
      close: async () => { lifetime.abort(); owner?.dispose(); await f.close(); } };
  } catch (error) { lifetime.abort(); owner?.dispose(); await f.close(); throw error; }
}
