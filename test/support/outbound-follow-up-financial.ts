import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { outboundClinicalVoiceFixture } from "./outbound-clinical-voice.ts";
import { fixture, intentValue, keys, value } from "./financial-retention.ts";
import { verificationCanaries, verificationNow } from "./caller-verification.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { approvedFinancialVoicePolicy } from "../../src/standalone/approved-financial-voice-policy.ts";
import { OwnerFileFinancialFeePolicy } from "../../src/standalone/owner-file-financial-fee-policy.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { declareClinikoRequestCost } from "../../src/cliniko/request-cost.ts";
import type { FinancialVoiceProvision } from "../../src/standalone/financial-voice-provision.ts";


/** Shared real signed call fixture; remote providers and clinic approval are synthetic. */
export async function until(check: () => boolean, label: string) {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, label + " timed out"); await new Promise<void>(resolve => setTimeout(resolve, 5)); }
}
export async function financialCall(options: Pick<NonNullable<Parameters<typeof outboundClinicalVoiceFixture>[0]>, "services" | "budget" | "apiKey" | "recipientNumber" | "identities" | "sessionEffects"> & { financialBarrier?: NonNullable<Parameters<typeof fixture>[0]>["barrierFactory"] } = {}) {
  const rateBudget = options.budget ?? new ClinikoReadBudget(180, () => 0); let claims = 0;
  const budget = { claim() { claims++; return rateBudget.claim(); }, observe429: rateBudget.observe429.bind(rateBudget),
    ...(rateBudget.checkHeadroom ? { checkHeadroom: rateBudget.checkHeadroom.bind(rateBudget) } : {}),
    ...(rateBudget.withReservation ? { withReservation: rateBudget.withReservation.bind(rateBudget) } : {}) };
  let funding!: ReturnType<typeof fixture>, policyCalls = 0;
  const financialLife = new AbortController(), seen: string[] = [], grants = { live: true };
  const { financialBarrier, ...callOptions } = options;
  const f = await outboundClinicalVoiceFixture({ ...callOptions, purpose: "followUp", budget, ...(options.services ? { services: true } : {}), financial: async context => {
    const c = context.cliniko;
    funding = fixture({ intent: { ...intentValue(), scope: context.scope }, config: { scope: context.scope, apiKey: c.apiKey,
      businessId: c.businessId, contactEmail: c.contactEmail, rateBudget: c.rateBudget, clock: context.clock },
      barrierFactory: financialBarrier ?? (native => {
        const binding = value(financialRecordOwnerBinding(native)), burned = new Set<string>();
        return { matches: (scope, owner) => JSON.stringify(scope) === JSON.stringify(native.scope) && owner === binding,
          claimOnce: async ref => { const claimed = !burned.has(ref); burned.add(ref); return { ok: true, value: { claimed } }; } };
      }),
      response: (row, method) => { if (method === "POST") { row.created_at = context.clock(); row.updated_at = row.created_at; }
        return Response.json(row, { status: method === "POST" ? 201 : 200 }); } });
    const wrap = (port: typeof fetch): typeof fetch => async (input, init) => {
      const url = new URL(String(input)), body = init?.method === "POST" ? JSON.parse(String(init.body)) : undefined;
      if (url.pathname === "/v1/recalls" && body?.recall_type_id === "40" ||
          url.pathname.startsWith("/v1/recalls/") && funding.rows.has(url.pathname.split("/").at(-1)!)) return funding.port(input, init);
      if (url.pathname === "/v1/recalls" && init?.method === "GET" && url.searchParams.getAll("q[]").some(q => q.startsWith("patient_id:="))) {
        const rows: Record<string, unknown>[] = [...funding.rows.values(), ...context.clinicalReviews().map(row => ({ ...row,
          links: { self: `${url.origin}/v1/recalls/${row.id}` }, created_at: verificationNow, updated_at: verificationNow }))];
        rows.sort((a, b) => Number(a.id) - Number(b.id)); const page = Number(url.searchParams.get("page") ?? "1");
        return Response.json({ total_entries: rows.length, recalls: rows.slice((page - 1) * 100, page * 100) });
      }
      return port(input, init);
    };
    const path = join(context.folder, "outbound-financial-fees.json"), fp = clinikoCredentialFingerprint(c.apiKey);
    await writeFile(path, JSON.stringify({ scope: context.scope, revision: "fees-v1", approverRef: "synthetic-admin",
      approvedAt: "2026-10-01T00:00:00.000Z", effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveUntil: "2026-10-06T00:00:00.000Z", approved: true, enabled: true,
      selection: { policyVersion: context.policyVersion, businessId: c.businessId, credentialFingerprint: fp, practitionerId: c.practitionerId,
        appointmentTypeId: options.services ? "34" : c.appointmentTypeId, timeZone: c.timeZone, bookingKind: "book", passUse: "none" },
      terms: { kind: "required", amount: 5000, currency: "gbp", policyVersion: "fee-policy-1", termsVersion: "financial-terms-1",
        approvedTerms: "The clinic will review late payment; no automatic refund is promised.", paymentWindowMinutes: 1320, reviewDatePolicy: "paymentDeadlineClinicDate" } }), { mode: 0o600 });
    const fees = value(await OwnerFileFinancialFeePolicy.capture({ path, scope: context.scope, directory: context.directory, clock: context.clock }, financialLife.signal));
    // Native registered recipient remains independently checked by the real
    // approved per-call policy. The fixture transport is injected after routing.
    let provider!: typeof fetch;
    const wrapped = (port: typeof fetch) => { provider = wrap(port); return provider; };
    const create = approvedFinancialVoicePolicy({ fees, native: funding.config, fetchPort: (input, init) => provider(input, init),
      recipientAuthority: { allows: async q => grants.live && q.booking.patientId === verificationCanaries[2], current: q => grants.live && q.booking.patientId === verificationCanaries[2] } });
    const binding = { scope: context.scope, credentialFingerprint: fp, budget: c.rateBudget };
    const provision: FinancialVoiceProvision = { native: funding.config, privateKey: keys.privateKey,
      authority: { allows: declareClinikoRequestCost(funding.authority.allows.bind(funding.authority), binding, 0),
        producerAdmitted: declareClinikoRequestCost(funding.authority.producerAdmitted.bind(funding.authority), binding, 0), current: funding.authority.current.bind(funding.authority) },
      sourceAuthorized: declareClinikoRequestCost(async () => grants.live, binding, 0), barrier: funding.barrier, financialSignal: financialLife.signal,
      fetchPort: (input, init) => provider(input, init), policyForCall(call) { policyCalls++; const policy = create(call);
        return { ...policy, current: declareClinikoRequestCost(policy.current.bind(policy), binding, 1) }; } };
    return { provision, wrap: wrapped };
  }, intent: owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-only", model: "synthetic-clinical", clinicDate: () => "2026-10-04",
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body)), text = JSON.parse(request.input[1].content).callerText; seen.push(text);
      const decision = { kind: "unsupported", operation: null as string | null, stage: null, from: null as string | null, to: null as string | null, choice: null as number | null };
      if (text === "I need to book an appointment.") { decision.kind = "workflow"; decision.operation = "book"; }
      else if (text === "What times are available on October 8?") { decision.kind = "menu"; decision.from = "2026-10-08"; decision.to = "2026-10-08"; }
      else if (text === "The second time, please.") { decision.kind = "choice"; decision.choice = 2; }
      else assert.fail("Only ordinary public requests may reach synthetic classification");
      return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
    } }) });
  return { f, funding, seen, grants, get claims() { return claims; }, get policyCalls() { return policyCalls; }, close: async () => { await f.close(); financialLife.abort(); } };
}

type FinancialCall = Awaited<ReturnType<typeof financialCall>>;
export async function selectBooking(c: FinancialCall, requested = "I need to book an appointment.") {
  const f = c.f;
  await f.open(); assert.deepEqual(f.spoken, ["Hello, this is Abby calling on behalf of the clinic."]); assert.equal(c.policyCalls, 1);
  await f.mark(); await f.say(requested, { kind: "workflow", operation: "book" });
  const code = await f.waitForMail(); await f.mark(); await f.privateCode(code);
  await f.say("What times are available on October 8?", { kind: "bookingMenu", from: "2026-10-08", to: "2026-10-08" }); await f.mark();
  await f.say("The second time, please.", { kind: "bookingChoice", choice: 2 });
  const input = f.flow.financialBookingInput; assert.ok(input);
  return { code, input };
}
export async function playTerms(c: FinancialCall) {
  const f = c.f;
  const input = f.flow.financialBookingInput; assert.ok(input); assert.equal(Object.keys((await f.current()).actions).length, 0);
  // A digit before the public private-input notice is played cannot start a
  // private quote or count as consent. Check actual handled wire completion.
  let parts = 0;
  while (input.inputAdmission()?.phase === "unplayed") {
    assert.ok(++parts <= 16); const marks = f.sent.filter(x => x.event === "mark").length;
    await f.privateKey("1"); await until(() => f.sent.filter(x => x.event === "mark").length > marks, "private payment speech mark");
    await f.privateKey("1"); assert.equal(input.inputAdmission(), undefined);
    assert.equal(input.readySelection, undefined); assert.equal(f.sent.filter(x => x.event === "mark").length, marks + 1);
    await f.privateNoise(); await f.mark(); await until(() => input.inputAdmission() !== undefined || !input.inputActive, "private payment played receipt");
  }
  assert.ok(parts > 2); assert.equal(input.inputAdmission()?.phase, "awaiting"); assert.equal(f.bookings, 0);
  return input;
}

