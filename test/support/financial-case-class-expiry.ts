import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { unlinkedClassExpiryFixture, value, stop } from "./financial-unlinked-class-expiry.ts";
import { classLink } from "./class-attendance.ts";
import { now } from "./financial-retention.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { OwnerFileClassPolicy } from "../../src/standalone/owner-file-class-policy.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { ClinikoFinancialCaseClassExpiryOwner } from "../../src/standalone/cliniko-financial-case-class-expiry.ts";
import type { FinancialCaseClassExpiryAuthority, FinancialCaseClassApproval } from "../../src/standalone/cliniko-financial-case-class-expiry.ts";
import type { ClassPassCancellationEffect } from "../../src/standalone/cliniko-class-pass-cancellation.ts";

type BaseOptions = NonNullable<Parameters<typeof unlinkedClassExpiryFixture>[0]>;
export async function caseClassExpiryFixture(options: Omit<BaseOptions, "authority" | "barrierFor" | "requestedCase"> & {
  originalCase?: string; includeCancelled?: boolean; includeDna?: boolean; arrivedFalse?: boolean;
  authority?: Partial<FinancialCaseClassExpiryAuthority>; barrierFor?: BaseOptions["barrierFor"];
  caseRead?(path: string, count: number, signal: AbortSignal): void | Promise<void>;
} = {}) {
  let clock = Date.parse(now), claims = 0, caseReads = 0;
  const budget = new ClinikoReadBudget(180, () => clock), burned = new Set<string>();
  let f!: Awaited<ReturnType<typeof unlinkedClassExpiryFixture>>;
  const { authority: _authority, caseRead: _caseRead, originalCase: _originalCase, includeCancelled: _cancelled,
    includeDna: _dna, arrivedFalse: _arrived, ...baseOptions } = options;
  f = await unlinkedClassExpiryFixture({ ...baseOptions, requestedCase: options.originalCase ?? "71", barrierFor(config) {
    Object.assign(config.rateBudget, { claim: () => { claims++; return budget.claim(); }, observe429: budget.observe429.bind(budget),
      checkHeadroom: budget.checkHeadroom.bind(budget) });
    if (options.barrierFor) return options.barrierFor(config);
    const binding = value(financialRecordOwnerBinding(config));
    return { matches: (scope, owner) => JSON.stringify(scope) === JSON.stringify(config.scope) && owner === binding,
      claimOnce: async effect => { const claimed = !burned.has(effect); burned.add(effect); return { ok: true, value: { claimed } }; } };
  }, beforeCancel: options.beforeCancel ?? (() => { assert.ok(burned.has(f.intent.effects.clinicalExpiry)); }) });
  try {
    clock = Date.parse(f.config.cliniko.clock!()); claims = 0;
    const includeCancelled = options.includeCancelled ?? false, includeDna = options.includeDna ?? false;
    const effect: ClassPassCancellationEffect = includeCancelled ? options.arrivedFalse && !includeDna ? "consumeOne" : "unchanged"
      : options.arrivedFalse && !includeDna ? "unchanged" : "releaseOne";
    const cancellation = { version: "case-cancel-1", releaseOne: "Cancelling releases one counted session.",
      unchanged: "Cancelling does not change the counted sessions.", consumeOne: "Cancelling consumes one counted session." };
    const policyValue = { ...f.approval, revision: "class-case-expiry-1", membership: "nativeCaseSessions" as const,
      caseSessions: { attendanceStatus: "arrivedFalseIsDna" as const, counting: "allLinkedNonArchivedAttendees" as const,
        dates: "inclusiveClinicDate" as const, consumption: "onePerAttendance" as const, financialAuthority: "independentHost" as const, cancellation } };
    await writeFile(f.classPolicyPath, JSON.stringify(policyValue), { mode: 0o600 });
    const classPolicy = value(await OwnerFileClassPolicy.capture({ ...policyValue, path: f.classPolicyPath,
      directory: new OwnerFileAdminDirectory(f.classDirectoryPath, f.intent.scope), clock: f.config.cliniko.clock! }));
    f.attendee.patient_case = classLink("patient_cases", "71"); f.attendee.arrived = options.arrivedFalse ? false : null;
    const rows: Record<string, unknown>[] = [f.attendee];
    const record: Record<string, unknown> = { id: "71", ...classLink("patient_cases", "71"), patient: classLink("patients", f.intent.patientId),
      max_sessions: 300, include_cancelled_attendees: includeCancelled, include_dna_attendees: includeDna,
      issue_date: "2026-11-01", expiry_date: "2026-11-30", closed_at: null, archived_at: null, attendee_ids: ["91"],
      name: "private-class-case-name", notes: "private-class-case-notes" };
    const native: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/v1/patient_cases/71")) {
        assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error");
        await options.caseRead?.(url.pathname, ++caseReads, init.signal!);
        if (url.pathname === "/v1/patient_cases/71") { assert.deepEqual(url.searchParams.getAll("q[]"), ["archived_at:*"]); return Response.json(record); }
        assert.equal(url.pathname, "/v1/patient_cases/71/attendees");
        assert.deepEqual(url.searchParams.getAll("q[]"), ["archived_at:*", "cancelled_at:*", "deleted_at:*"]);
        const page = Number(url.searchParams.get("page")); return Response.json({ total_entries: rows.length, attendees: rows.slice((page - 1) * 100, page * 100) });
      }
      if (url.pathname === "/v1/attendees/91" && init?.method === "GET") return Response.json(f.attendee);
      return f.classNative(input, init);
    };
    let approval: FinancialCaseClassApproval | null = { kind: "cancelUnpaidCaseClass", classPolicyVersion: policyValue.policyVersion,
      caseTermsVersion: cancellation.version, approvedCaseTerms: cancellation[effect], patientCaseId: "71", entitlementRef: "case-entitlement-71", caseEffect: effect,
      policyVersion: f.intent.payment.policyVersion, termsVersion: f.intent.payment.termsVersion,
      approvedTerms: "If this exact class deposit remains unpaid and unwaived after the deadline, the clinic may cancel this attendance.",
      timeZone: policyValue.timeZone, cancellationReason: 50 };
    const authority: FinancialCaseClassExpiryAuthority = { ...f.classAuthority, clinicalApproval: async () => approval, ...options.authority };
    const config = { ...f.config, classPolicy, maximumAuthorityRequests: 0, ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }) };
    const make = () => ClinikoFinancialCaseClassExpiryOwner.create(config, authority, f.recordsAuthority, f.barrier, native, f.expiryStripePort);
    const owner = value(make());
    return { ...f, caseConfig: config, caseAuthority: authority, caseNative: native, classPolicy, casePolicyValue: policyValue, caseRows: rows, caseRecord: record,
      burned, budget, get claims() { return claims; }, get caseReads() { return caseReads; }, caseEffect: effect, makeCase: make,
      expireCase: (signal = stop()) => owner.expireOnce(f.binding, signal), denyClinical: () => { approval = null; },
      changeCaseApproval: (change: Partial<FinancialCaseClassApproval>) => { approval = { ...approval!, ...change }; },
      changeCasePolicy: async (change: Partial<typeof policyValue>) => writeFile(f.classPolicyPath, JSON.stringify({ ...policyValue, ...change }), { mode: 0o600 }) };
  } catch (error) { await f.close(); throw error; }
}
export { value, stop };
