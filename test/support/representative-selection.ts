import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { ClinikoRepresentativeSelection } from "../../src/standalone/cliniko-representative-selection.ts";
import type { RepresentativeAuthorization } from "../../src/standalone/cliniko-representative-selection.ts";
import type { PatientOperation } from "../../src/standalone/transient-patient-proof.ts";
import type { CallerVerificationApproval, OwnerFileCallerPolicy } from "../../src/standalone/owner-file-caller-policy.ts";
import { OwnerFileRepresentativePolicy } from "../../src/standalone/owner-file-representative-policy.ts";
import { callerVerificationFixture, verificationCanaries } from "./caller-verification.ts";
import { resultValue } from "./agent-appointment-proposals.ts";

/** Native-shaped synthetic related patients. Actor authentication is the actual
 * self caller verifier; permission and registered subjects are independent. */
export async function representativeFixture(rateBudget?: import("../../src/cliniko/read-budget.ts").ClinikoRequestBudget,
  provided?: Readonly<{ fixture: Pick<Awaited<ReturnType<typeof callerVerificationFixture>>,
    "scope" | "folder" | "sessionConfig" | "session" | "ledger" | "policies" | "inbound" | "receipt" | "callId" | "sessionId" | "mail" | "close" |
    "state" | "runtime" | "setTime" | "setPermitted" | "setEmail" | "provider" | "replaceAccount"> & Readonly<{ config: Parameters<typeof OwnerFileCallerPolicy.capture>[0] }>; operation: PatientOperation }>) {
  const f = provided?.fixture ?? await callerVerificationFixture(rateBudget ? { rateBudget } : {});
  const rootApproval = JSON.parse(await readFile(f.config.path, "utf8")) as CallerVerificationApproval;
  const operation = provided?.operation ?? "appointments.read";
  const path = join(f.folder, "representative.json"), callerPath = join(f.folder, "representative-caller.json");
  const lifetime = new AbortController(), base = "https://api.au5.cliniko.com/v1";
  const identity = { firstName: "Synthetic", lastName: "Subject Canaries", dateOfBirth: "1982-03-05" };
  const patients = new Map([
    ["43", { id: "43", first_name: identity.firstName, last_name: identity.lastName, date_of_birth: identity.dateOfBirth,
      archived_at: null, email: "subject-one-private@example.test", patient_phone_numbers: [{ number: "+61499999888", phone_type: "Mobile" }] }],
    ["44", { id: "44", first_name: "Synthetic", last_name: "Second Person", date_of_birth: "2014-02-28",
      archived_at: null, email: "subject-two-private@example.test", patient_phone_numbers: [{ number: "+61499999777", phone_type: "Mobile" }] }],
  ]);
  const relation = (id: string, subjectId: string) => ({ id, archived_at: null, updated_at: "2026-10-04T05:00:00.000Z", relation: 60,
    patient: { links: { self: `${base}/patients/${verificationCanaries[2]}` } }, related_patient: { links: { self: `${base}/patients/${subjectId}` } } });
  let relations = [relation("101", "43"), relation("102", "44")];
  const authorizations = new Map<string, RepresentativeAuthorization>([
    ["43", { authorityRef: "approved-adult", version: "1", expiresAt: "2026-10-04T06:02:00.000Z", subjectKind: "adult", authorityKind: "adultRepresentative" }],
    ["44", { authorityRef: "approved-guardian", version: "1", expiresAt: "2026-10-04T06:02:00.000Z", subjectKind: "minor", authorityKind: "guardian" }],
  ]);
  const common = Object.fromEntries(["scope", "revision", "approverRef", "approvedAt", "effectiveFrom", "effectiveUntil", "approved", "enabled"].map(key => [key, rootApproval[key as keyof typeof rootApproval]]));
  let approval = { ...common, policyVersion: f.sessionConfig.policyVersion, businessId: "11", credentialFingerprint: clinikoCredentialFingerprint("synthetic-session-au5"),
    timeZone: "Australia/Sydney", subjects: "nativeRelatedPatients", identity: "exactNameAndBirthDate", caller: "freshRegisteredChannelProof",
    authority: "independentClinicHost", recipient: "selectedPatientRegisteredEmail", adultAgeYears: 18, leapDayBirthday: "march1",
    allowedAuthorities: ["adultRepresentative", "guardian"], operations: [operation] };
  let callerApproval = { ...rootApproval, operations: [operation], representatives: "independentClinicHost", representativeRecipient: "selectedPatientRegisteredEmail" };
  const write = (file: string, value: unknown) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await write(path, approval); await write(callerPath, callerApproval);
  const policyConfig = { path, scope: f.scope, policyVersion: f.sessionConfig.policyVersion, businessId: "11", credentialFingerprint: approval.credentialFingerprint,
    timeZone: "Australia/Sydney", directory: f.config.directory, clock: f.sessionConfig.clock };
  const policy = resultValue(await OwnerFileRepresentativePolicy.capture(policyConfig));
  let lookupAllowed = true, operationsAllowed = true, budgetAllowed = true;
  let fault: "partial" | "ambiguous" | "foreign" | "archived" | "duplicate" | "drift" | "pageDrift" | "oversized" | undefined;
  let afterSubjectRead: (() => void) | undefined;
  const requests: string[] = [], queries: string[] = [], mail: { email: string; code: string }[] = [];
  const permission: ConstructorParameters<typeof ClinikoRepresentativeSelection>[0]["permission"] = {
    allowsLookup: async query => {
      assert.equal(query.caller.patientRef, verificationCanaries[2]); assert.equal(query.scope.locationId, f.scope.locationId);
      return lookupAllowed;
    },
    authorize: async query => {
      queries.push(`${query.subjectPatientId}:${query.purpose}`);
      assert.ok(relations.some(row => row.id === query.relationshipId && row.related_patient.links.self.endsWith(`/patients/${query.subjectPatientId}`)));
      return query.purpose === "operation" && !operationsAllowed ? undefined : authorizations.get(query.subjectPatientId);
    },
  };
  const fetchPort: typeof fetch = async (incoming, init) => {
    const url = new URL(String(incoming)); assert.equal(init?.method ?? "GET", "GET"); assert.equal(url.origin, "https://api.au5.cliniko.com");
    requests.push(url.pathname + url.search);
    if (url.pathname === "/v1/relationships") {
      assert.equal(url.searchParams.get("q[]"), `patient_id:=${verificationCanaries[2]}`);
      if (fault === "partial") return Response.json({ total_entries: 3, relationships: [] });
      if (fault === "duplicate") return Response.json({ total_entries: 2, relationships: [relations[0], relations[0]] });
      if (fault === "foreign") return Response.json({ total_entries: 1, relationships: [{ ...relations[0], patient: { links: { self: "https://api.us1.cliniko.com/v1/patients/1" } } }] });
      if (fault === "archived") return Response.json({ total_entries: 1, relationships: [{ ...relations[0], archived_at: "2026-10-04T05:00:00.000Z" }] });
      const page = Number(url.searchParams.get("page"));
      return Response.json({ total_entries: fault === "oversized" ? 501 : relations.length + (fault === "pageDrift" && page > 1 ? 1 : 0), relationships: relations.slice((page - 1) * 100, page * 100) });
    }
    if (url.pathname.startsWith("/v1/relationships/")) {
      const row = relations.find(row => url.pathname.endsWith(`/${row.id}`));
      return Response.json(fault === "drift" ? { ...row, updated_at: "2026-10-04T05:01:00.000Z" } : row);
    }
    if (url.pathname.startsWith("/v1/patients/")) {
      const row = patients.get(url.pathname.split("/").at(-1)!);
      const response = Response.json(fault === "ambiguous" && row?.id === "44" ? { ...patients.get("43"), id: "44" } : row);
      afterSubjectRead?.(); return response;
    }
    if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", archived_at: null, time_zone_identifier: "Australia/Sydney" });
    assert.equal(url.pathname, "/v1/individual_appointments");
    assert.equal(url.searchParams.getAll("q[]").some(query => query.includes("patient_id:=43")), true);
    return Response.json({ total_entries: 0, individual_appointments: [] });
  };
  const config: ConstructorParameters<typeof ClinikoRepresentativeSelection>[0] = {
    receipt: f.receipt, inbound: f.inbound, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
    ledger: f.ledger, policies: f.policies, lookup: f.sessionConfig.lookup, delivery: { send: async (email, code) => { mail.push({ email, code }); return true; } },
    verificationBudget: { reserve: async () => true }, directory: f.config.directory, actor: f.session, actorOperation: f.sessionConfig.operation, policy,
    representativeCallerApprovalPath: callerPath, permission, signal: lifetime.signal, clock: f.sessionConfig.clock, fetchPort,
    cliniko: { apiKey: "synthetic-session-au5", contactEmail: "test@example.test", businessId: "11", practitionerId: "22", appointmentTypeId: "33", recallTypeId: "7",
      countryCallingCode: "61", timeZone: "Australia/Sydney", rateBudget: { claim: () => !budgetAllowed ? { kind: "unavailable" } : rateBudget ? rateBudget.claim() : null, observe429: header => rateBudget ? rateBudget.observe429(header) : { kind: "rateLimited" } } },
  };
  const owner = new ClinikoRepresentativeSelection(config);
  const verifyActor = async () => { f.session.begin(); await new Promise<void>(resolve => setImmediate(resolve));
    const deadline = Date.now() + 5000;
    while (!f.mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
    assert.ok(f.mail[0]); assert.equal((await f.session.submitCode(f.mail[0].code)).verified, true); };
  const select = () => owner.select(identity, operation, lifetime.signal);
  const verifySubject = async () => {
    const chosen = resultValue(await select()), verifier = resultValue(await owner.verifier(chosen.selectionRef, lifetime.signal));
    verifier.begin(); const deadline = Date.now() + 5000;
    while (!mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
    assert.ok(mail[0]); assert.equal((await verifier.submitCode(mail[0].code)).verified, true); return verifier;
  };
  return { f, identity, patients, authorizations, requests, queries, mail, policyConfig, config, owner, lifetime, verifyActor, select, verifySubject,
    setFault: (value: typeof fault) => { fault = value; }, setLookup: (value: boolean) => { lookupAllowed = value; },
    setOperations: (value: boolean) => { operationsAllowed = value; }, setBudget: (value: boolean) => { budgetAllowed = value; },
    afterSubjectRead: (run: () => void) => { afterSubjectRead = run; },
    setRelations: (value: typeof relations) => { relations = value; },
    replaceApproval: async (patch: Record<string, unknown>) => { approval = { ...approval, ...patch }; await write(path, approval); },
    replaceCaller: async (patch: Record<string, unknown>) => { callerApproval = { ...callerApproval, ...patch }; await write(callerPath, callerApproval); },
    close: async () => { lifetime.abort(); owner.dispose(); await f.close(); },
  };
}
