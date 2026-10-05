import { isDeepStrictEqual } from "node:util";
import { readFile, writeFile, rename, unlink, lstat } from "node:fs/promises";
import { getuid } from "node:process";
import { boundedClinikoJson } from "../../src/cliniko/bounded-json.ts";
import { ClinikoReadBudget, claimClinikoBudget, observeCliniko429, clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { normalizePatientPhone } from "../../src/cliniko/phone-number.ts";

export const lifecycleScope = { tenantId: "abby-live-lifecycle", clinicId: "demo", locationId: "supervised" };
export const lifecyclePolicyVersion = "demo:lifecycle:bestEffort";
export const lifecycleTypeName = "Abby supervised lifecycle rehearsal";
// ACMA's published fictional mobile; .test cannot deliver to a real mailbox.
export const lifecycleDraft = Object.freeze({ firstName: "Abby", lastName: "LiveLifecycle",
  email: "abby-live-lifecycle@example.test", dateOfBirth: "1990-05-21", patientPhone: "+61491570156", phoneType: "Mobile" as const });
export type Row = Record<string, unknown>;
export const row = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LifecycleFailure("invalidProviderShape");
  return value as Row;
};
const id = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
export function requireLive(check: unknown, kind: string): asserts check {
  if (!check) throw new LifecycleFailure(kind);
}
export class LifecycleFailure extends Error {
  readonly kind: string;
  constructor(kind: string) { super(kind); this.kind = kind; }
}
export type LiveSelection = Readonly<{ businessId: string; practitionerId: string; appointmentTypeId: string;
  durationMinutes: number; timeZone: string; recallTypeId: string }>;
type BusinessRecovery = { businessId: string; originalOnline: boolean; expectedUpdatedAt: string; state: "pending" | "enabled" };

/** Demo-only ownership and cleanup. Patient/action references never leave process memory or Cliniko. */
export class ClinikoLifecycleFixture {
  readonly base: string;
  readonly budget: ClinikoRequestBudget;
  readonly #key: string;
  readonly #contact: string;
  readonly #fetch: typeof fetch;
  readonly #recoveryFile: string;
  readonly #snapshots = new Map<string, Row>();
  #patientId: string | undefined;
  #typeId: string | undefined;
  #recovery: BusinessRecovery | undefined;
  #ownsRun = false;
  #businessRestoreVerified = false;
  readonly #cooldown: () => Promise<void>;
  readonly counts = { intake: 0, book: 0, reschedule: 0, cancel: 0, recall: 0 };
  readonly reads = {patients:0,businesses:0,practitioners:0,appointment_types:0,individual_appointments:0,recalls:0,other:0,failed:0,maxMs:0};
  constructor(config: { apiKey: string; contactEmail: string; recoveryFile: string }, fetchPort: typeof fetch = fetch,
    ports: {budget?: ClinikoRequestBudget; cooldown?: () => Promise<void>} = {}) {
    const shard = config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1];
    requireLive(shard && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.contactEmail) && config.recoveryFile.startsWith("/"), "invalidConfig");
    this.base = `https://api.${shard}.cliniko.com/v1`; this.#key = config.apiKey;
    this.#contact = config.contactEmail; this.#fetch = fetchPort; this.#recoveryFile = config.recoveryFile;
    this.budget=ports.budget ?? new ClinikoReadBudget(180);
    this.#cooldown=ports.cooldown ?? (()=>new Promise<void>(resolve=>setTimeout(resolve,61_000)));
  }
  get ownsRun() { return this.#ownsRun; }
  get businessTemporarilyEnabled() { return this.#recovery?.originalOnline===false; }
  get businessRestored() { return this.#businessRestoreVerified; }
  /** Close the prior owner before waiting: no live caller proof or offer is extended by this pause. */
  betweenWorkflows() { return this.#cooldown(); }
  #headers() { return { Accept: "application/json", "Content-Type": "application/json",
    Authorization: `Basic ${Buffer.from(`${this.#key}:`).toString("base64")}`, "User-Agent": `Abby demo lifecycle (${this.#contact})` }; }
  async request(method: "GET" | "POST" | "PATCH", path: string, body?: Row): Promise<Row> {
    requireLive(!await claimClinikoBudget(this.budget), "providerBudgetUnavailable");
    let response: Response;
    try { response = await this.#fetch(this.base+path, { method, headers: this.#headers(), redirect: "error",
      signal: AbortSignal.timeout(15_000), ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new LifecycleFailure(method === "GET" ? "providerUnavailable" : "mutationUncertain"); }
    if (response.status === 429) await observeCliniko429(this.budget, response.headers.get("X-RateLimit-Reset"));
    if (path.split("?")[0]!.endsWith("/archive")) {
      requireLive(response.status === 204, `archiveUncertain_${response.status}_${path.split("/")[1]}`); return {};
    }
    requireLive(response.status === (method === "POST" ? 201 : 200), method === "GET" ? `providerReadRejected_${response.status}_${path.split("/")[1]?.split("?")[0]}` : "mutationUncertain");
    const parsed = await boundedClinikoJson(response); requireLive(parsed.ok, "invalidProviderShape"); return row(parsed.value);
  }
  async list(resource: string, query: readonly string[] = []): Promise<Row[]> {
    const all: Row[] = []; let total: number | undefined;
    for (let page=1; page<=5; page++) {
      const q = new URLSearchParams({ per_page: "100", page: String(page), sort: "id:asc" });
      query.forEach(value => q.append("q[]", value));
      const body = await this.request("GET", `/${resource}?${q}`), entries = body[resource.split("/").at(-1)!];
      requireLive(Array.isArray(entries) && Number.isSafeInteger(body.total_entries) && Number(body.total_entries)>=0 &&
        Number(body.total_entries)<=500 && (total===undefined || total===body.total_entries) &&
        entries.length===Math.min(100, Math.max(0, Number(body.total_entries)-(page-1)*100)), "incompleteProviderList");
      total = Number(body.total_entries);
      for (const value of entries) {
        const current=row(value); requireLive(id(current.id) && !all.some(prior=>prior.id===current.id), "invalidProviderShape"); all.push(current);
      }
      if (all.length===total) return all;
    }
    throw new LifecycleFailure("incompleteProviderList");
  }
  link(record: Row, field: string): unknown { return row(row(record[field]).links).self; }
  ownsPatient(record: Row): boolean {
    const d=lifecycleDraft, phones=record.patient_phone_numbers;
    return id(record.id) && record.first_name===d.firstName && record.last_name===d.lastName && record.email===d.email &&
      record.date_of_birth===d.dateOfBirth && record.archived_at===null && !record.notes && !record.appointment_notes &&
      !record.old_reference_id && Array.isArray(phones) && phones.length===1 && row(phones[0]).phone_type===d.phoneType &&
      normalizePatientPhone(String(row(phones[0]).number), "61")===d.patientPhone;
  }
  async patients(): Promise<Row[]> {
    const email=await this.list("patients",[`email:=${lifecycleDraft.email}`]);
    const name=await this.list("patients",[`last_name:=${lifecycleDraft.lastName}`]);
    return [...new Map([...email,...name].map(record=>[record.id,record])).values()];
  }
  async status(report:(resource:string,facts:Record<string,boolean|number|string>)=>void) {
    const patients=await this.patients();report("patients",{count:patients.length,allOwned:patients.every(p=>this.ownsPatient(p))});
    for(const patient of patients) {
      for(const resource of ["individual_appointments","recalls"]) {
        try {const records=await this.list(resource,[`patient_id:=${patient.id}`,...(resource==="individual_appointments"?["cancelled_at:*"]:[])]);
          report(resource,{count:records.length,active:records.filter(r=>!r.cancelled_at && !r.archived_at).length});}
        catch(error) {report(resource,{kind:error instanceof LifecycleFailure?error.kind:"unavailable"});}
      }
    }
    const types=await this.list("recall_types");report("recall_types",{count:types.filter(t=>t.name===lifecycleTypeName).length});
    const businesses=await this.list("businesses");report("businesses",{count:businesses.length,online:businesses[0]?.show_in_online_bookings===true});
  }
  #same(resource:string,left:Row,right:Row) {
    const fields=resource==="individual_appointments" ? ["id","updated_at","notes","starts_at","ends_at","cancelled_at","cancellation_reason","archived_at","deleted_at","patient","business","practitioner","appointment_type"] :
      resource==="recalls" ? ["id","updated_at","notes","recall_at","recalled","recalled_at","archived_at","patient","recall_type"] :
      resource==="patients" ? ["id","updated_at","first_name","last_name","email","date_of_birth","patient_phone_numbers","notes","appointment_notes","old_reference_id","archived_at"] :
      ["id","updated_at","name","default_duration","default_duration_type","archived_at"];
    return fields.every(field=>isDeepStrictEqual(left[field],right[field]));
  }
  async preflight() {
    const businesses=await this.list("businesses"), practitioners=await this.list("practitioners"), types=await this.list("appointment_types");
    requireLive(businesses.length===1 && practitioners.length===1 && practitioners[0]!.active===true &&
      practitioners[0]!.show_in_online_bookings===true, "unexpectedDemoCatalogue");
    const business=await this.request("GET", `/businesses/${businesses[0]!.id}`);
    requireLive(business.archived_at===null && typeof business.show_in_online_bookings==="boolean" &&
      typeof business.time_zone_identifier==="string", "unexpectedDemoCatalogue");
    new Intl.DateTimeFormat("en", {timeZone:business.time_zone_identifier});
    const related=await this.list(`practitioners/${practitioners[0]!.id}/appointment_types`);
    const type=types.find(t=>t.archived_at===null && t.show_in_online_bookings===true &&
      Number.isSafeInteger(t.duration_in_minutes) && Number(t.duration_in_minutes)>0 &&
      related.some(r=>r.id===t.id) && Array.isArray(business.appointment_type_ids) && business.appointment_type_ids.includes(t.id));
    requireLive(type, "noEligibleDemoType");
    return { business, practitioner:practitioners[0]!, type };
  }
  async prepare(): Promise<LiveSelection> {
    const catalogue=await this.preflight();
    requireLive(!(await this.patients()).length && !(await this.list("recall_types")).some(t=>t.name===lifecycleTypeName), "existingFixtureRequiresCleanup");
    const b=catalogue.business;
    requireLive(id(b.id) && typeof b.updated_at==="string", "invalidProviderShape");
    const recovery:BusinessRecovery={ businessId:b.id, originalOnline:b.show_in_online_bookings===true,
      expectedUpdatedAt:b.updated_at, state:b.show_in_online_bookings===false?"pending":"enabled" };
    await writeFile(this.#recoveryFile, JSON.stringify(recovery), { mode:0o600, flag:"wx" });
    this.#recovery=recovery;this.#ownsRun=true;
    if (b.show_in_online_bookings===false) {
      const enabled=await this.request("PATCH", `/businesses/${b.id}`, {show_in_online_bookings:true});
      requireLive(enabled.id===b.id && enabled.show_in_online_bookings===true && typeof enabled.updated_at==="string", "businessEnableUncertain");
      this.#recovery={...this.#recovery,expectedUpdatedAt:enabled.updated_at,state:"enabled"};
      await writeFile(this.#recoveryFile+".new", JSON.stringify(this.#recovery), {mode:0o600,flag:"wx"});
      await rename(this.#recoveryFile+".new",this.#recoveryFile);
    }
    const created=await this.request("POST", "/recall_types", {name:lifecycleTypeName,default_duration:1,default_duration_type:10});
    requireLive(id(created.id) && created.name===lifecycleTypeName && created.archived_at===null, "typeCreateUncertain");
    this.#typeId=created.id; this.#snapshots.set(`recall_types/${created.id}`, created);
    return {businessId:String(b.id),practitionerId:String(catalogue.practitioner.id),appointmentTypeId:String(catalogue.type.id),
      durationMinutes:Number(catalogue.type.duration_in_minutes),timeZone:String(b.time_zone_identifier),recallTypeId:created.id};
  }
  /** Actual provider traffic; the guard confines every rehearsal mutation to this synthetic fixture. */
  readonly workflowFetch: typeof fetch = async (input,init) => {
    const url=new URL(String(input)), method=init?.method ?? "GET";
    requireLive(url.origin===new URL(this.base).origin && url.pathname.startsWith("/v1/") && init?.redirect==="error", "unsafeProviderRequest");
    const path=url.pathname.slice(4); let category: "intake" | "book" | "reschedule" | "cancel" | "recall" | undefined;
    if (method!=="GET") {
      const body=init?.body ? row(JSON.parse(String(init.body))) : {};
      if (method==="POST" && path==="patients") {
        requireLive(!this.#patientId && body.first_name===lifecycleDraft.firstName && body.last_name===lifecycleDraft.lastName &&
          body.email===lifecycleDraft.email && body.date_of_birth===lifecycleDraft.dateOfBirth &&
          isDeepStrictEqual(body.patient_phone_numbers,[{number:lifecycleDraft.patientPhone,phone_type:lifecycleDraft.phoneType}]), "unsafeIntakeSend"); category="intake";
      } else if (method==="POST" && (path==="individual_appointments" || path==="recalls")) {
        requireLive(this.#patientId && body.patient_id===this.#patientId, "unsafePatientSend");
        if (path==="recalls") {
          const decoded=decodeClinikoReview(body.notes);
          requireLive(body.recall_type_id===this.#typeId && decoded.ok && isDeepStrictEqual(decoded.value.request.scope,lifecycleScope) &&
            decoded.value.request.policyVersion===lifecyclePolicyVersion, "unsafeRecallSend"); category="recall";
        } else { requireLive(typeof body.notes==="string" && /^Abby booking [0-9a-f-]{36}$/.test(body.notes), "unsafeBookingSend"); category="book"; }
      } else if (method==="PATCH" && /^individual_appointments\/[1-9][0-9]*(\/cancel)?$/.test(path)) {
        const owned=this.#snapshots.get(path.replace(/\/cancel$/,"")); requireLive(owned && this.link(owned,"patient")===`${this.base}/patients/${this.#patientId}`, "unsafeChangeSend");
        category=path.endsWith("/cancel")?"cancel":"reschedule";
      } else throw new LifecycleFailure("unsafeProviderMutation");
      this.counts[category]++;
    }
    const started=Date.now();let response:Response;
    try {response=await this.#fetch(input,init);} catch(error) {this.reads.failed++;throw error;}
    this.reads.maxMs=Math.max(this.reads.maxMs,Date.now()-started);
    if(method==="GET") {
      const resource=path.split("/")[0]!;
      if(["patients","businesses","practitioners","appointment_types","individual_appointments","recalls"].includes(resource)) this.reads[resource as "patients"]++;
      else this.reads.other++;
      if(!response.ok)this.reads.failed++;
    }
    // This clone witnesses fixtures only; no alteration of the real adapter response.
    if (response.ok && ((method==="POST" && ["patients","recalls","individual_appointments"].includes(path)) ||
        (method==="PATCH" && !path.endsWith("/cancel")))) {
      const parsed=await boundedClinikoJson(response.clone()); requireLive(parsed.ok,"invalidProviderShape"); const record=row(parsed.value);
      requireLive(id(record.id),"invalidProviderShape");
      if(path==="patients") { requireLive(this.ownsPatient(record),"intakeOwnershipMismatch"); this.#patientId=record.id; }
      this.#snapshots.set(`${path.split("/")[0]}/${record.id}`,record);
    }
    return response;
  };
  async inspectAppointment(recordId: string): Promise<Row> {
    requireLive(id(recordId),"invalidAppointmentRef");
    const record=await this.request("GET",`/individual_appointments/${recordId}?q%5B%5D=cancelled_at%3A*`);
    requireLive(record.id===recordId && this.link(record,"patient")===`${this.base}/patients/${this.#patientId}` &&
      typeof record.notes==="string" && /^Abby booking [0-9a-f-]{36}$/.test(record.notes),"appointmentOwnershipMismatch");
    this.#snapshots.set(`individual_appointments/${recordId}`,record); return record;
  }
  async #archive(resource: string, record: Row) {
    const cancelled=resource==="individual_appointments" ? "&q%5B%5D=cancelled_at%3A*" : "";
    const current=await this.request("GET",`/${resource}/${record.id}${cancelled ? "?"+cancelled.slice(1) : ""}`);
    requireLive(this.#same(resource,current,record),"fixtureEditedBeforeCleanup");
    await this.request("POST",`/${resource}/${record.id}/archive${cancelled ? "?"+cancelled.slice(1) : ""}`);
    const after=await this.request("GET",`/${resource}/${record.id}?q%5B%5D=archived_at%3A*${cancelled}`);
    requireLive(after.id===record.id && typeof after.archived_at==="string" && Number.isFinite(Date.parse(after.archived_at)),"archiveUnverified");
  }
  async restoreBusiness() {
    let recovery=this.#recovery;
    if (!recovery) {
      try {
        const st=await lstat(this.#recoveryFile); requireLive(st.isFile() && (st.mode&0o077)===0 && typeof getuid==="function" && st.uid===getuid(),"unsafeRecoveryFile");
        recovery=JSON.parse(await readFile(this.#recoveryFile,"utf8")) as BusinessRecovery;
      } catch(error) { if(error instanceof Error && "code" in error && error.code==="ENOENT") return; throw error; }
    }
    requireLive(id(recovery.businessId) && typeof recovery.originalOnline==="boolean" && recovery.state==="enabled" &&
      typeof recovery.expectedUpdatedAt==="string", "businessRecoveryRequiresInspection");
    const current=await this.request("GET",`/businesses/${recovery.businessId}`);
    requireLive(current.updated_at===recovery.expectedUpdatedAt && current.show_in_online_bookings===true,"businessEditedBeforeRestore");
    const restored=recovery.originalOnline ? current : await this.request("PATCH",`/businesses/${recovery.businessId}`,{show_in_online_bookings:false});
    const verified=await this.request("GET",`/businesses/${recovery.businessId}`);
    requireLive(restored.show_in_online_bookings===recovery.originalOnline && verified.show_in_online_bookings===recovery.originalOnline,"businessRestoreUnverified");
    await unlink(this.#recoveryFile); this.#recovery=undefined;this.#businessRestoreVerified=true;
  }
  async cleanup() {
    try {
      const patients=await this.patients(), types=(await this.list("recall_types")).filter(t=>t.name===lifecycleTypeName);
      requireLive(patients.length<=1 && types.length<=1 && patients.every(p=>this.ownsPatient(p)) &&
        types.every(t=>t.default_duration===1 && t.default_duration_type===10),"ambiguousFixtureCleanup");
      const patient=patients[0], type=types[0];
      if(patient) {
        const appointments=await this.list("individual_appointments",[`patient_id:=${patient.id}`,"cancelled_at:*"]);
        const recalls=await this.list("recalls",[`patient_id:=${patient.id}`]);
        for(const appointment of appointments) {
          requireLive(this.link(appointment,"patient")===`${this.base}/patients/${patient.id}` && typeof appointment.notes==="string" &&
            /^Abby booking [0-9a-f-]{36}$/.test(appointment.notes),"foreignAppointmentCleanup");
        }
        for(const recall of recalls) {
          const decoded=decodeClinikoReview(recall.notes);
          requireLive(type && decoded.ok && decoded.value.request.patientId===patient.id &&
            isDeepStrictEqual(decoded.value.request.scope,lifecycleScope) && decoded.value.request.policyVersion===lifecyclePolicyVersion &&
            decoded.value.request.credentialFingerprint===clinikoCredentialFingerprint(this.#key) &&
            this.link(recall,"patient")===`${this.base}/patients/${patient.id}` && this.link(recall,"recall_type")===`${this.base}/recall_types/${type.id}`,"foreignRecallCleanup");
        }
        for(const [resource,records] of [["individual_appointments",appointments],["recalls",recalls],["patients",patients]] as const) {
          for(const record of records) {
            // Archiving its child appointments can update Cliniko's patient
            // revision. Refresh after those changes, while rejecting any change
            // to the original private fixture fields before the final archive.
            const target=resource==="patients" ? await this.request("GET",`/patients/${record.id}`) : record;
            requireLive(resource!=="patients" || (this.ownsPatient(target) &&
              this.#same(resource,{...record,updated_at:target.updated_at},target)),"patientEditedDuringCleanup");
            const snapshot=this.#snapshots.get(`${resource}/${record.id}`);
            // Cliniko can advance the patient's revision when its appointment
            // changes. Compare the original private fields, then #archive
            // rechecks the freshly read revision immediately before cleanup.
            const baseline=snapshot && resource==="patients" ? {...snapshot,updated_at:target.updated_at} : snapshot;
            requireLive(!baseline || this.#same(resource,baseline,target),`fixtureEditedBeforeCleanup_${resource}`); await this.#archive(resource,target);
          }
        }
      }
      if(type) {
        requireLive(!(await this.list("recalls")).some(recall=>this.link(recall,"recall_type")===`${this.base}/recall_types/${type.id}`),"typeStillReferenced");
        const snapshot=this.#snapshots.get(`recall_types/${type.id}`);
        requireLive(!snapshot || this.#same("recall_types",snapshot,type),"fixtureEditedBeforeCleanup"); await this.#archive("recall_types",type);
      }
      requireLive(!(await this.patients()).length && !(await this.list("recall_types")).some(t=>t.name===lifecycleTypeName),"cleanupUnverified");
    } finally { await this.restoreBusiness(); }
  }
}
