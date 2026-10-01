import { array, bool, choice, key, object, str, uint } from "./schema-shapes.ts";
import type { JsonSchema } from "./schema-shapes.ts";
import { READINESS_REQUIREMENTS } from "../core/readiness.ts";
import { STAFF_REASONS } from "../core/model.ts";

const schemaUri = "https://json-schema.org/draft/2020-12/schema";
const root = (schema: JsonSchema): JsonSchema => ({ $schema: schemaUri, ...schema });
const optional = (properties: Record<string, JsonSchema>, required: readonly string[]): JsonSchema => object(properties, required);
const nonEmpty: JsonSchema = { type: "string", minLength: 1 };
const result = (value: JsonSchema): JsonSchema => root({ oneOf: [
  object({ ok: { const: true }, value }),
  object({ ok: { const: false }, error: { oneOf: [object({ kind: choice(
    "forbidden", "invalid", "commandOutcomeUnknown", "responseContractViolation", "versionConflict", "invalidValue", "storageFailure", "storageCorrupt", "effectFailure",
    "callUnknown", "callConflict", "invalidTransition", "scopeMismatch", "evidenceExpired", "confirmationMissing",
    "digestChanged", "effectUnknown", "keyMismatch", "admissionExpired", "leaseLost", "staleTurn",
    "routeChanged", "policyChanged", "credentialForbidden", "catalogueRateLimited", "catalogueUnavailable", "selectionUnavailable", "staleCatalogue",
    "notApproved", "staleApproval",
  ) }), object({ kind: { const: "readinessFailed" }, missing: { type: "array", items: choice(...READINESS_REQUIREMENTS), minItems: 1, uniqueItems: true } })] } }),
] });
const reply = (kind: string, name: string, value: JsonSchema): JsonSchema => object({ kind: { const: kind }, [name]: value });
const scope = object({ tenantId: nonEmpty, clinicId: nonEmpty, locationId: nonEmpty });
const destination = { oneOf: [object({ kind: { const: "owner" }, ownerRef: nonEmpty }),
  object({ kind: { const: "queue" }, queueRef: nonEmpty })] } satisfies JsonSchema;
const capabilityMode = choice("execute", "requestOnly", "unavailable");
const afterHoursMode = choice("staffRequest", "approvedInfoAndRequest");
const afterHoursInfo = object({ scope, version: key, ownerRef: key,
  approvedText: { type: "string", minLength: 1, maxLength: 1_500 }, approved: { const: true } });
const policy = optional({ scope, policyVersion: nonEmpty, automationVersion: nonEmpty, automationEnabled: bool, bookingEnabled: bool,
  afterHoursMode, afterHoursInfo,
  urgentResponse: object({ scope, version: key, ownerRef: key,
    approvedText: { type: "string", minLength: 1, maxLength: 1_500 }, approved: { const: true },
    effectiveFrom: str, effectiveUntil: str }),
  capabilities: object({ book: capabilityMode, cancel: capabilityMode, reschedule: capabilityMode,
    intake: capabilityMode, transfer: capabilityMode }), transferDestinationRef: str,
  staffedIntervals: { type: "array", items: object({ startsAt: str, endsAt: str }), maxItems: 512 },
  staffDestination: destination, operatorQueue: destination, staffWorkEnabled: bool, numberRouteVersion: key,
  greeting: object({ scope, version: key, ownerRef: key, approvedText: { type: "string", minLength: 1, maxLength: 2_000 },
    approved: { const: true } }),
  knowledgeSnapshot: { type: "array", items: object({ sourceRef: key, version: key }), maxItems: 256, uniqueItems: true } },
["scope", "policyVersion", "automationVersion", "automationEnabled", "bookingEnabled", "capabilities", "staffDestination", "operatorQueue"]);
const auditEntry = { oneOf: [
  object({ version: key, enabled: bool, provenance: { const: "recorded" }, actorRef: key,
    previousEnabled: bool, changedAt: str }),
  object({ version: key, enabled: bool, provenance: { const: "legacyUnattributed" } }),
] } satisfies JsonSchema;
const auditPage = optional({ entries: array(auditEntry), nextAfterVersion: uint }, ["entries"]);
const automationAuditPage = optional({ entries: array(object({ version: key, enabled: bool, previousEnabled: bool,
  actorRef: key, changedAt: str })), nextAfterVersion: uint }, ["entries"]);
const afterHoursAuditPage = optional({ entries: array(optional({ version: key, mode: afterHoursMode,
  previousMode: afterHoursMode, infoVersion: key, actorRef: key, changedAt: str },
["version", "mode", "previousMode", "actorRef", "changedAt"])), nextAfterVersion: uint }, ["entries"]);
const urgentAuditPage = optional({ entries: array(optional({ version: key, enabled: bool, previousEnabled: bool,
  scriptVersion: key, actorRef: key, changedAt: str },
["version", "enabled", "previousEnabled", "actorRef", "changedAt"])), nextAfterVersion: uint }, ["entries"]);
const actionKind = choice("book", "cancel", "reschedule", "intake");
const actionStatus = choice("awaitingConfirmation", "ready", "dispatched", "committed", "rejected",
  "unsupported", "uncertain", "needsReview", "canceled");
const staffReason = choice(...STAFF_REASONS);
const writeStop = optional({ stopped: bool, version: key, actorRef: key, reason: nonEmpty,
  changedAt: str, inFlight: array(object({ effectId: key, callId: key, actionKey: key,
    status: choice("possiblySent", "uncertain") })), nextAfterEffectId: key }, ["stopped", "version", "inFlight"]);
const writeStopAudit = optional({ entries: array(object({ version: key, stopped: bool, actorRef: key,
  reason: nonEmpty, changedAt: str })), nextAfterVersion: uint }, ["entries"]);
const staffStatus = choice("requested", "open", "acknowledged", "resolved", "needsReview", "failed");
const lifecycle = choice("starting", "active", "ended");
const source = object({ sourceRef: key, version: key, ownerRef: key });
const knowledgeEntry = object({ scope, sourceRef: key, version: key, status: choice("draft", "approved", "revoked"),
  ownerRef: key, text: { type: "string", minLength: 1, maxLength: 2_000 }, effectiveFrom: str, effectiveUntil: str,
  actorRef: key, changedAt: str });
const availability = optional({ status: choice("shown", "empty", "failed"), sourceRef: str,
  timeZone: str, shownCount: uint, reason: str }, ["status", "shownCount"]);
const appointments = optional({ status: choice("shown", "empty", "failed"), sourceRef: str,
  shownCount: uint, reason: str }, ["status", "shownCount"]);
const progress = optional({ callId: key, traceKey: key, callVersion: uint, lifecycle,
  actions: array(object({ actionKey: key, kind: actionKind, status: actionStatus, presentationId: key })),
  staffItems: array(object({ taskKey: key, reason: staffReason, status: staffStatus })),
  pendingPresentation: object({ presentationId: key, kind: choice("speech", "notice", "transfer"),
    status: choice("pending", "started", "played", "interrupted", "failed", "unproven", "superseded",
      "possiblySent", "connected", "canceled") }),
  knowledgeSources: array(source), availability, appointments },
["callId", "traceKey", "callVersion", "lifecycle", "actions", "staffItems", "knowledgeSources"]);
const terminal = object({ reason: choice("callerDisconnected", "sessionClosed", "mediaFailure", "localLeaseClosed",
  "admissionExpired", "leaseExpired", "transferConnected", "transferUnproven"), at: str });
const callSummary = optional({ callId: key, lifecycle, version: uint, terminal,
  actions: array(object({ kind: actionKind, status: actionStatus })),
  staffItems: array(object({ reason: staffReason, status: staffStatus })), knowledgeAnswers: array(source),
  availabilityReads: array(availability), appointmentReads: array(appointments) },
["callId", "lifecycle", "version", "actions", "staffItems", "knowledgeAnswers", "availabilityReads", "appointmentReads"]);
const outcomeRow = optional({ callId: key, lifecycle, terminalReason: terminal.properties!.reason!,
  committedActions: uint, unresolvedActions: uint, staffRequests: uint, hostConfirmedTasks: uint,
  staffNeedsReview: uint, systemFailure: bool },
["callId", "lifecycle", "committedActions", "unresolvedActions", "staffRequests", "hostConfirmedTasks", "staffNeedsReview", "systemFailure"]);
const totals = object({ calls: uint, committedActions: uint, callsWithUnresolvedActions: uint,
  callsWithStaffRequests: uint, callsWithHostConfirmedTasks: uint, callsWithStaffNeedsReview: uint,
  callsWithSystemFailure: uint, callsWithCallerDisconnect: uint, callsWithMediaFailure: uint,
  callsWithLeaseExpiry: uint, callsWithTransferConnected: uint });
const outcomePage = optional({ rows: array(outcomeRow), totals, nextAfterCallId: key }, ["rows", "totals"]);
const alerts = optional({ overdue: choice("pending", "delivered", "uncertain", "failed", "canceled"),
  needsReview: choice("pending", "delivered", "uncertain", "failed", "canceled") }, []);
const staffEntry = optional({ callId: key, callVersion: uint, taskKey: key, reason: staffReason, status: staffStatus,
  dueAt: str, destination, linkedActionKey: key, pendingChangeKey: key, reviewRequired: bool, alerts, overdue: bool },
["callId", "callVersion", "taskKey", "reason", "status", "dueAt", "destination", "overdue"]);
const staffPage = optional({ items: array(staffEntry), nextAfterTaskKey: key }, ["items"]);
const staffHealth = object({ observedAt: str, consistency: { const: "nonAtomicScan" }, scanned: uint,
  statuses: object({ requested: uint, open: uint, acknowledged: uint, resolved: uint,
    needsReview: uint, failed: uint }), overdue: uint, reviewRequired: uint, pendingChange: uint,
  alertPending: uint, alertUncertain: uint, alertFailed: uint });
const operationalCounts = object({ admissionDenied: uint, callOwnerStarted: uint, voiceFailure: uint,
  callEnded: uint, clinikoBudgetDenied: uint, clinikoBudgetUnavailable: uint,
  clinikoProvider429: uint, clinikoProviderUnavailable: uint });
const operationalDaily = object({ days: { type: "array", minItems: 7, maxItems: 7,
  items: object({ date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    counts: operationalCounts }) } });
const staffChange = object({ kind: { const: "staffChange" }, taskKey: key, callVersion: uint,
  status: staffStatus, pending: bool, reviewRequired: bool });
const turn = optional({ callId: key, sessionId: key, turnId: key, text: { type: "string", minLength: 1 },
  quality: choice("clear", "needsClarification"), at: str }, ["callId", "turnId", "text", "quality", "at"]);
const change = { oneOf: [object({ kind: { const: "acknowledge" } }), object({ kind: { const: "resolve" } }),
  object({ kind: { const: "reassign" }, target: choice("staff", "operator") })] } satisfies JsonSchema;
const nullable = (value: JsonSchema): JsonSchema => ({ oneOf: [value, { const: null }] });
const providerId: JsonSchema = { type: "string", pattern: "^[1-9][0-9]*$", maxLength: 20 };
const clinicAvailabilitySelection = object({ businessId: providerId, practitionerId: providerId,
  appointmentTypeId: providerId, policyVersion: { type: "string", pattern: "^[A-Za-z0-9._-]{1,128}$" } });
const clinicAvailabilityRoute = object({ accountRef: key,
  dialedNumber: { type: "string", pattern: "^\\+[1-9][0-9]{1,14}$" }, routeVersion: key });
const clinicAvailabilityBusinessCatalogue = object({ scope, observedAt: str, credentialFingerprint: key,
  status: { const: "complete" }, businesses: array(object({ businessId: providerId,
    name: str, timeZone: nullable(str), onlineBooking: bool, archived: bool })) });
const clinicAvailabilityPractitionerCatalogue = object({ scope, businessId: providerId, observedAt: str,
  credentialFingerprint: key, status: { const: "complete" }, practitioners: array(object({
    practitionerId: providerId, name: str, active: bool, onlineBooking: bool })) });
const clinicAvailabilityTypeCatalogue = object({ scope, businessId: providerId, practitionerId: providerId,
  observedAt: str, credentialFingerprint: key, status: { const: "complete" }, appointmentTypes: array(object({
    appointmentTypeId: providerId, name: str, onlineBooking: bool, archived: bool, businessSelected: bool })) });
const clinicAvailabilitySelectionSnapshot = object({ scope, selection: clinicAvailabilitySelection,
  observedAt: str, credentialFingerprint: key, businessName: str, practitionerName: str,
  appointmentTypeName: str, timeZone: nullable(str), status: choice("candidate", "unavailable"),
  reasons: array(str), patientActionMode: { const: "unavailable" }, patientRequestMode: { const: "unavailable" } });
const clinicAvailabilityApproval = object({ scope, route: clinicAvailabilityRoute,
  selection: clinicAvailabilitySelection,
  alternatives: { type: "array", items: clinicAvailabilitySelection, maxItems: 2, uniqueItems: true },
  businessTimeZone: { type: "string", minLength: 1, maxLength: 128 },
  credentialFingerprint: key, catalogueObservedAt: str,
  approvedBy: key, approvedAt: str, patientActionMode: { const: "unavailable" },
  patientRequestMode: { const: "unavailable" } });
const clinicAvailabilityApprovalState = object({ version: uint, approval: nullable(clinicAvailabilityApproval) });

export type CapabilityDescriptor = Readonly<{
  id: string;
  inputVersion: 1 | 2;
  outputVersion: 1 | 2;
  inputSchema: JsonSchema;
  resultSchema: JsonSchema;
  scope: "boundActorLocation";
  preconditions: readonly CapabilityPrecondition[];
  effect: "read" | "policyChange" | "proposalOnly" | "staffChange";
  authority: "permittedActor" | "clinicAdmin" | "staffOrAdmin";
  approval: "none" | "callerConfirmation";
  requiresCallerConfirmation: boolean;
}>;

export type CapabilityPrecondition = "expectedPolicyVersion" | "expectedAutomationVersion" | "readinessForEnable" | "activeCall" | "bookingEnabledForExecution" |
  "hostEvidenceForExecution" | "approvedKnowledgeForAnswer" | "availabilityHostConfigured" |
  "appointmentHostConfigured" | "hostIssuedPatientProof" |
  "callReviewAvailable" | "outcomeReportAvailable" | "staffQueueAvailable" | "operationalDailyAvailable" |
  "hostConfirmedTask" | "expectedCallVersion" | "availabilitySetupAvailable" | "expectedAvailabilityApprovalVersion";

function entry(id: string, input: JsonSchema, success: JsonSchema, effect: CapabilityDescriptor["effect"],
               authority: CapabilityDescriptor["authority"], approval: CapabilityDescriptor["approval"] = "none",
               preconditions: readonly CapabilityPrecondition[] = []): CapabilityDescriptor {
  const version = id.endsWith(".v2") ? 2 : 1;
  return { id, inputVersion: version, outputVersion: version, inputSchema: root(input), resultSchema: result(success),
    scope: "boundActorLocation", preconditions, effect, authority, approval,
    requiresCallerConfirmation: approval === "callerConfirmation" };
}

export const capabilityCatalogue = {
  "settings.read.v1": entry("settings.read.v1", object({ kind: { const: "settings.read.v1" } }),
    reply("settings", "policy", policy), "read", "permittedActor"),
  "settings.automation.enabled.change.v1": entry("settings.automation.enabled.change.v1",
    object({ kind: { const: "settings.automation.enabled.change.v1" }, expectedVersion: key, enabled: bool }),
    reply("settings", "policy", policy), "policyChange", "clinicAdmin", "none", ["expectedAutomationVersion", "readinessForEnable"]),
  "settings.automation.audit.v1": entry("settings.automation.audit.v1",
    optional({ kind: { const: "settings.automation.audit.v1" }, afterVersion: uint }, ["kind"]),
    reply("automationSettingAudit", "page", automationAuditPage), "read", "clinicAdmin"),
  "calls.writes.stop.v1": entry("calls.writes.stop.v1",
    object({ kind: { const: "calls.writes.stop.v1" }, reason: { type: "string", minLength: 1, maxLength: 1000 } }),
    reply("writeStop", "status", writeStop), "policyChange", "clinicAdmin"),
  "calls.writes.stop.read.v1": entry("calls.writes.stop.read.v1",
    optional({ kind: { const: "calls.writes.stop.read.v1" }, afterEffectId: key }, ["kind"]),
    reply("writeStop", "status", writeStop), "read", "clinicAdmin"),
  "calls.writes.resume.v1": entry("calls.writes.resume.v1",
    object({ kind: { const: "calls.writes.resume.v1" }, expectedVersion: key,
      reason: { type: "string", minLength: 1, maxLength: 1000 } }),
    reply("writeStop", "status", writeStop), "policyChange", "clinicAdmin", "none", ["readinessForEnable"]),
  "calls.writes.stop.audit.v1": entry("calls.writes.stop.audit.v1",
    optional({ kind: { const: "calls.writes.stop.audit.v1" }, afterVersion: uint }, ["kind"]),
    reply("writeStopAudit", "page", writeStopAudit), "read", "clinicAdmin"),
  "settings.appointments.booking.enabled.change.v1": entry("settings.appointments.booking.enabled.change.v1",
    object({ kind: { const: "settings.appointments.booking.enabled.change.v1" }, expectedVersion: key, enabled: bool }),
    reply("settings", "policy", policy), "policyChange", "clinicAdmin", "none", ["expectedPolicyVersion"]),
  "settings.appointments.booking.audit.v1": entry("settings.appointments.booking.audit.v1",
    optional({ kind: { const: "settings.appointments.booking.audit.v1" }, afterVersion: uint }, ["kind"]),
    reply("bookingSettingAudit", "page", auditPage), "read", "clinicAdmin"),
  "settings.routing.afterHours.change.v1": entry("settings.routing.afterHours.change.v1",
    { oneOf: [
      object({ kind: { const: "settings.routing.afterHours.change.v1" }, expectedVersion: key,
        mode: { const: "staffRequest" } }),
      object({ kind: { const: "settings.routing.afterHours.change.v1" }, expectedVersion: key,
        mode: { const: "approvedInfoAndRequest" }, infoVersion: { type: "string", minLength: 1, maxLength: 128 },
        approvedText: { type: "string", minLength: 1, maxLength: 1_500 } }),
    ] },
    reply("settings", "policy", policy), "policyChange", "clinicAdmin", "none", ["expectedPolicyVersion"]),
  "settings.routing.afterHours.audit.v1": entry("settings.routing.afterHours.audit.v1",
    optional({ kind: { const: "settings.routing.afterHours.audit.v1" }, afterVersion: uint }, ["kind"]),
    reply("afterHoursSettingAudit", "page", afterHoursAuditPage), "read", "clinicAdmin"),
  "settings.routing.urgent.change.v1": entry("settings.routing.urgent.change.v1",
    { oneOf: [
      object({ kind: { const: "settings.routing.urgent.change.v1" }, expectedVersion: key, enabled: { const: false } }),
      object({ kind: { const: "settings.routing.urgent.change.v1" }, expectedVersion: key, enabled: { const: true },
        scriptVersion: { type: "string", minLength: 1, maxLength: 128 },
        approvedText: { type: "string", minLength: 1, maxLength: 1_500 }, effectiveFrom: str, effectiveUntil: str }),
    ] }, reply("settings", "policy", policy), "policyChange", "clinicAdmin", "none", ["expectedPolicyVersion"]),
  "settings.routing.urgent.audit.v1": entry("settings.routing.urgent.audit.v1",
    optional({ kind: { const: "settings.routing.urgent.audit.v1" }, afterVersion: uint }, ["kind"]),
    reply("urgentSettingAudit", "page", urgentAuditPage), "read", "clinicAdmin"),
  "booking.propose.v2": entry("booking.propose.v2",
    object({ kind: { const: "booking.propose.v2" }, turn, verificationRef: key, offerRef: key, now: str }),
    reply("bookingProposal", "progress", progress), "proposalOnly", "permittedActor", "callerConfirmation", ["activeCall", "bookingEnabledForExecution", "hostEvidenceForExecution"]),
  "calls.turn.model.v1": entry("calls.turn.model.v1",
    object({ kind: { const: "calls.turn.model.v1" }, turn, now: str }),
    reply("modelTurn", "progress", progress), "proposalOnly", "permittedActor", "none", ["activeCall"]),
  "knowledge.answer.v2": entry("knowledge.answer.v2",
    object({ kind: { const: "knowledge.answer.v2" }, turn,
      sourceRefs: { type: "array", items: key, minItems: 1, maxItems: 8, uniqueItems: true },
      proposedText: { type: "string", minLength: 1, maxLength: 2_000 }, now: str }),
    reply("knowledgeAnswer", "progress", progress), "proposalOnly", "permittedActor", "none", ["activeCall", "approvedKnowledgeForAnswer"]),
  "knowledge.list.v1": entry("knowledge.list.v1", object({ kind: { const: "knowledge.list.v1" } }),
    reply("knowledgeList", "entries", array(knowledgeEntry)), "read", "clinicAdmin"),
  "knowledge.draft.save.v1": entry("knowledge.draft.save.v1",
    object({ kind: { const: "knowledge.draft.save.v1" }, sourceRef: key, expectedVersion: key, ownerRef: key,
      text: { type: "string", minLength: 1, maxLength: 2_000 }, effectiveFrom: str, effectiveUntil: str }),
    reply("knowledgeEntry", "entry", knowledgeEntry), "policyChange", "clinicAdmin"),
  "knowledge.approve.v1": entry("knowledge.approve.v1",
    object({ kind: { const: "knowledge.approve.v1" }, sourceRef: key, expectedVersion: key }),
    reply("knowledgeEntry", "entry", knowledgeEntry), "policyChange", "clinicAdmin"),
  "knowledge.revoke.v1": entry("knowledge.revoke.v1",
    object({ kind: { const: "knowledge.revoke.v1" }, sourceRef: key, expectedVersion: key }),
    reply("knowledgeEntry", "entry", knowledgeEntry), "policyChange", "clinicAdmin"),
  "clinic.availability.businesses.list.v1": entry("clinic.availability.businesses.list.v1",
    object({ kind: { const: "clinic.availability.businesses.list.v1" } }),
    reply("clinicAvailabilityBusinesses", "catalogue", clinicAvailabilityBusinessCatalogue),
    "read", "clinicAdmin", "none", ["availabilitySetupAvailable"]),
  "clinic.availability.practitioners.list.v1": entry("clinic.availability.practitioners.list.v1",
    object({ kind: { const: "clinic.availability.practitioners.list.v1" }, businessId: providerId }),
    reply("clinicAvailabilityPractitioners", "catalogue", clinicAvailabilityPractitionerCatalogue),
    "read", "clinicAdmin", "none", ["availabilitySetupAvailable"]),
  "clinic.availability.types.list.v1": entry("clinic.availability.types.list.v1",
    object({ kind: { const: "clinic.availability.types.list.v1" }, businessId: providerId, practitionerId: providerId }),
    reply("clinicAvailabilityTypes", "catalogue", clinicAvailabilityTypeCatalogue),
    "read", "clinicAdmin", "none", ["availabilitySetupAvailable"]),
  "clinic.availability.selection.inspect.v1": entry("clinic.availability.selection.inspect.v1",
    object({ kind: { const: "clinic.availability.selection.inspect.v1" }, selection: clinicAvailabilitySelection }),
    reply("clinicAvailabilitySelection", "snapshot", clinicAvailabilitySelectionSnapshot),
    "read", "clinicAdmin", "none", ["availabilitySetupAvailable"]),
  "clinic.availability.approval.read.v1": entry("clinic.availability.approval.read.v1",
    object({ kind: { const: "clinic.availability.approval.read.v1" } }),
    reply("clinicAvailabilityApprovalState", "state", clinicAvailabilityApprovalState),
    "read", "clinicAdmin", "none", ["availabilitySetupAvailable"]),
  "clinic.availability.route.check.v1": entry("clinic.availability.route.check.v1",
    object({ kind: { const: "clinic.availability.route.check.v1" } }),
    object({ kind: { const: "clinicAvailabilityRouteCheck" }, eligible: { const: true } }),
    "read", "clinicAdmin", "none", ["availabilitySetupAvailable"]),
  "clinic.availability.approval.change.v1": entry("clinic.availability.approval.change.v1",
    object({ kind: { const: "clinic.availability.approval.change.v1" }, route: clinicAvailabilityRoute,
      selection: clinicAvailabilitySelection, expectedVersion: uint }),
    reply("clinicAvailabilityApprovalState", "state", clinicAvailabilityApprovalState),
    "policyChange", "clinicAdmin", "none", ["availabilitySetupAvailable", "expectedAvailabilityApprovalVersion"]),
  "clinic.availability.approval.change.v2": entry("clinic.availability.approval.change.v2",
    object({ kind: { const: "clinic.availability.approval.change.v2" }, route: clinicAvailabilityRoute,
      selection: clinicAvailabilitySelection,
      alternatives: { type: "array", items: clinicAvailabilitySelection, maxItems: 2, uniqueItems: true },
      expectedVersion: uint }),
    reply("clinicAvailabilityApprovalState", "state", clinicAvailabilityApprovalState),
    "policyChange", "clinicAdmin", "none", ["availabilitySetupAvailable", "expectedAvailabilityApprovalVersion"]),
  "clinic.availability.approval.revoke.v1": entry("clinic.availability.approval.revoke.v1",
    object({ kind: { const: "clinic.availability.approval.revoke.v1" }, expectedVersion: uint }),
    reply("clinicAvailabilityApprovalState", "state", clinicAvailabilityApprovalState),
    "policyChange", "clinicAdmin", "none", ["availabilitySetupAvailable", "expectedAvailabilityApprovalVersion"]),
  "availability.read.v2": entry("availability.read.v2",
    object({ kind: { const: "availability.read.v2" }, turn, from: str, to: str, now: str }),
    reply("availabilityAnswer", "progress", progress), "read", "permittedActor", "none", ["activeCall", "availabilityHostConfigured"]),
  "appointments.read.v1": entry("appointments.read.v1",
    object({ kind: { const: "appointments.read.v1" }, turn, verificationRef: key, from: str, to: str, now: str }),
    reply("appointmentAnswer", "progress", progress), "read", "permittedActor", "none", ["activeCall", "appointmentHostConfigured", "hostIssuedPatientProof"]),
  "calls.read.v1": entry("calls.read.v1", object({ kind: { const: "calls.read.v1" }, callId: key }),
    reply("callSummary", "call", callSummary), "read", "permittedActor", "none", ["callReviewAvailable"]),
  "calls.outcomes.v1": entry("calls.outcomes.v1",
    optional({ kind: { const: "calls.outcomes.v1" }, afterCallId: key }, ["kind"]),
    reply("callOutcomes", "page", outcomePage), "read", "permittedActor", "none", ["outcomeReportAvailable"]),
  "staff.list.v1": entry("staff.list.v1", optional({ kind: { const: "staff.list.v1" }, afterTaskKey: key }, ["kind"]),
    reply("staffQueue", "page", staffPage), "read", "permittedActor", "none", ["staffQueueAvailable"]),
  "staff.health.v1": entry("staff.health.v1", object({ kind: { const: "staff.health.v1" } }),
    reply("staffQueueHealth", "health", staffHealth), "read", "permittedActor", "none", ["staffQueueAvailable"]),
  "operations.daily.v1": entry("operations.daily.v1", object({ kind: { const: "operations.daily.v1" } }),
    reply("operationalDaily", "daily", operationalDaily), "read", "clinicAdmin", "none", ["operationalDailyAvailable"]),
  "staff.change.v1": entry("staff.change.v1",
    object({ kind: { const: "staff.change.v1" }, callId: key, taskKey: key, expectedVersion: uint, change, now: str }),
    staffChange, "staffChange", "staffOrAdmin", "none", ["hostConfirmedTask", "expectedCallVersion"]),
} as const;

export type CapabilityId = keyof typeof capabilityCatalogue;

export function capabilityDescriptor(id: CapabilityId): CapabilityDescriptor {
  return structuredClone(capabilityCatalogue[id]);
}
