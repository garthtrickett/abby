import assert from "node:assert/strict";
import test from "node:test";
import { initialState, MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import type { ActionState, LocationScope } from "../../src/core/model.ts";
import { CallReview } from "../../src/reference/call-review.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";

const scope: LocationScope = { tenantId: "review-tenant", clinicId: "review-clinic", locationId: "review-location" };

test("staff and agents read a scoped call summary through the command gateway", async () => {
  const ledger = new MemoryLedger();
  const policy = new MemoryPolicyStore();
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  assert.equal((await reception.startCall("review-call", scope)).ok, true);
  const gateway = new CommandGateway({ actorRef: "review-staff", role: "staff", scope }, policy, reception, new CallReview(ledger));
  assert.equal(gateway.listPermitted().some(item => item.id === "calls.read.v1"), true);
  const found = await gateway.submit({ kind: "calls.read.v1", callId: "review-call" });
  assert.ok(found.ok && found.value.kind === "callSummary");
  assert.equal(found.value.call.lifecycle, "active");
  const other = new CommandGateway({ actorRef: "other-staff", role: "staff", scope: { ...scope, tenantId: "other-tenant" } }, policy, reception, new CallReview(ledger));
  const denied = await other.submit({ kind: "calls.read.v1", callId: "review-call" });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.kind, "callUnknown");
});

test("call review strips patient refs and approved speech from the projection", async () => {
  const state = initialState("private-call", referenceDefaultPolicy(scope));
  state.callerMessages.push("Private patient detail");
  state.knowledgeAnswers.push({ turnId: "private-turn", sourceRef: "hours", version: "hours-v1", ownerRef: "clinic-owner" });
  state.availabilityReads.push({ turnId: "private-availability", status: "shown", sourceRef: "cliniko:1:2:3", timeZone: "Australia/Sydney",
    observedAt: "2026-09-28T10:00:00.000Z", shownStartsAt: ["2026-10-01T10:00:00.000Z"] });
  state.appointmentReads.push({ turnId: "private-appointment", status: "shown", sourceRef: "cliniko:business:11:appointments", shownCount: 1 });
  state.presentations["private-presentation"] = { kind: "notice", id: "private-presentation", approvedText: "Private patient detail", status: "played" };
  const ledger = { read: async () => ok(state) } as unknown as LedgerStore;
  const result = await new CallReview(ledger).read("private-call", scope);
  assert.ok(result.ok);
  assert.equal(JSON.stringify(result.value).includes("Private patient detail"), false);
  assert.deepEqual(result.value.knowledgeAnswers, [{ sourceRef: "hours", version: "hours-v1", ownerRef: "clinic-owner" }]);
  assert.deepEqual(result.value.availabilityReads, [{ status: "shown", sourceRef: "cliniko:1:2:3", timeZone: "Australia/Sydney", shownCount: 1 }]);
  assert.deepEqual(result.value.appointmentReads, [{ status: "shown", sourceRef: "cliniko:business:11:appointments", shownCount: 1 }]);
  assert.equal(JSON.stringify(result.value).includes("2026-10-01T10:00:00.000Z"), false);
  assert.deepEqual(Object.keys(result.value).sort(), ["actions", "appointmentReads", "availabilityReads", "callId", "knowledgeAnswers", "lifecycle", "staffItems", "version"]);
  state.actions["corrupt"] = { kind: "book", status: "Private patient detail" } as unknown as ActionState;
  const corrupt = await new CallReview(ledger).read("private-call", scope);
  assert.equal(corrupt.ok, false);
  if (!corrupt.ok) assert.equal(corrupt.error.kind, "storageCorrupt");
});
