import { createHash } from "node:crypto";
import { decodeModelProposal } from "../model/proposal.ts";
import { validCallKnowledgeSource } from "./knowledge-evidence.ts";
import { err, ok } from "./model.ts";
import type { CallState, Result, TransitionAction, TransitionFailure } from "./model.ts";
import { addStaffTask } from "./staff-work.ts";
import { staffFallbackText, staffRequestNotice } from "./staff-fallback.ts";
import { urgentHandoffNotice } from "./urgent-response.ts";

function sourceDigest(refs: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(refs)).digest("hex");
}

function effectNotice(state: CallState, effectId: string, approvedText: string): void {
  state.callerMessages.push(approvedText);
  if (state.lifecycle !== "active" || state.pendingPresentationId) return;
  const id = `${effectId}:notice`;
  state.presentations[id] = { kind: "notice", id, approvedText, status: "pending" };
  state.pendingPresentationId = id;
}

export function cancelModelWork(state: CallState): void {
  for (const [id, effect] of Object.entries(state.effects)) {
    if ((effect.kind === "model" || effect.kind === "modelKnowledge") && effect.status === "pending") {
      state.effects[id] = { ...effect, status: "canceled" };
    }
  }
}

/** Returns false for an already settled result, so the ledger keeps its version. */
export function acceptModelResult(state: CallState, action: Extract<TransitionAction, { kind: "modelResolved" }>,
                                  now: string): Result<boolean, TransitionFailure> {
  const effect = state.effects[action.effectId];
  if (!effect || effect.kind !== "model") return err({ kind: "effectUnknown" });
  if (effect.status !== "pending") return ok(false);
  if (state.lifecycle !== "active" || state.conversationRevision !== effect.conversationRevision) {
    state.effects[effect.id] = { ...effect, status: "canceled" };
    return ok(true);
  }
  if (!action.result || typeof action.result.ok !== "boolean") return err({ kind: "invalidTransition" });
  if (!action.result.ok && (!action.result.error ||
      !["malformed", "unavailable", "deadlineExceeded"].includes(action.result.error.kind))) return err({ kind: "invalidTransition" });
  const proposal = action.result.ok ? decodeModelProposal(action.result.value) : undefined;
  if (proposal && !proposal.ok) return err({ kind: "invalidTransition" });
  state.effects[effect.id] = { ...effect, status: "completed" };
  if (!action.result.ok) {
    addStaffTask(state, "systemFailure", now);
    effectNotice(state, effect.id, staffFallbackText(state,
      "I couldn't understand that safely. I'll request staff follow-up."));
  } else if (proposal?.ok && proposal.value.kind === "handoff") {
    addStaffTask(state, proposal.value.reason, now);
    effectNotice(state, effect.id, proposal.value.reason === "potentiallyUrgent"
      ? urgentHandoffNotice(state, now) : staffRequestNotice(state));
  } else if (proposal?.ok && proposal.value.kind === "answer") {
    const id = `${effect.id}:knowledge`;
    state.effects[id] = { kind: "modelKnowledge", schemaVersion: 1, id, taskRef: effect.taskRef, turnId: effect.turnId,
      conversationRevision: effect.conversationRevision, sourceRefsDigest: sourceDigest(proposal.value.sourceRefs), status: "pending" };
  } else {
    addStaffTask(state, "unsupported", now);
    effectNotice(state, effect.id, staffFallbackText(state,
      "I can't complete that request automatically yet. I'll request staff follow-up."));
  }
  return ok(true);
}

export function acceptModelKnowledge(state: CallState, action: Extract<TransitionAction, { kind: "modelKnowledgeResolved" }>,
                                     now: string): Result<boolean, TransitionFailure> {
  const effect = state.effects[action.effectId];
  if (!effect || effect.kind !== "modelKnowledge") return err({ kind: "effectUnknown" });
  if (effect.status !== "pending") return ok(false);
  if (state.lifecycle !== "active" || state.conversationRevision !== effect.conversationRevision) {
    state.effects[effect.id] = { ...effect, status: "canceled" };
    return ok(true);
  }
  if (!action.result || typeof action.result.ok !== "boolean") return err({ kind: "invalidTransition" });
  if (!action.result.ok && (!action.result.error ||
      !["invalidQuery", "unavailable"].includes(action.result.error.kind))) return err({ kind: "invalidTransition" });
  const sources = action.result.ok && Array.isArray(action.result.value) ? action.result.value : [];
  const source = sources[0];
  const approved = action.result.ok && sources.length === 1 && !!source &&
    sourceDigest([source.sourceRef]) === effect.sourceRefsDigest &&
    validCallKnowledgeSource(source, state.policy, now) && action.proposedText === source.approvedText;
  state.effects[effect.id] = { ...effect, status: "completed" };
  if (approved && source) {
    state.knowledgeAnswers.push({ turnId: effect.turnId, sourceRef: source.sourceRef, version: source.version, ownerRef: source.ownerRef });
    effectNotice(state, effect.id, source.approvedText);
  } else {
    addStaffTask(state, "systemFailure", now);
    effectNotice(state, effect.id, staffFallbackText(state,
      "I can't verify that information right now. I'll request staff follow-up."));
  }
  return ok(true);
}
