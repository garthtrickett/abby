import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { proposeClinicVocabulary, reviewClinicVocabulary } from "../core/clinic-vocabulary.ts";
import type { ClinicVocabulary, VocabularyProposal } from "../core/clinic-vocabulary.ts";
import type { HostActor } from "../reference/command-gateway.ts";
import { approvalInstant } from "./owner-file-clinic-approval.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { OwnerFileClinicVocabulary } from "./owner-file-clinic-vocabulary.ts";
import type { ClinicVocabularyConfig } from "./owner-file-clinic-vocabulary.ts";

type Failure = Readonly<{ kind: "unavailable" | "staleVocabulary" | "invalidVocabulary" | "reviewBusy" }>;
type Review = Readonly<{ expectedBinding: string; expectedRevision: string; catalogueHash: string;
  manualPublicTerms: readonly string[]; selectedTerms: readonly string[] }>;
const unavailable = () => err({ kind: "unavailable" as const });

/** Backend-only public vocabulary editor. The embedding admin route must pass its
 * authenticated actor, never one from a request body. Existing owner approval
 * provisions the first file; this service cannot manufacture an owner or clinic.
 * All application writers use this exclusive lock. A crash-left lock is refused,
 * never stolen based on age or a remembered PID. Raw operator edits invalidate
 * captured bindings and must be reconciled before another review. */
export class ClinicVocabularyReview {
  readonly #config: ClinicVocabularyConfig;
  constructor(config: ClinicVocabularyConfig) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
  }
  async #snapshot(actor: HostActor, signal: AbortSignal) {
    actor = structuredClone(actor);
    const config = this.#config;
    if (!actor || actor.role !== "clinicAdmin" || actor.scope.tenantId !== config.scope.tenantId ||
        actor.scope.clinicId !== config.scope.clinicId || actor.scope.locationId !== config.scope.locationId || signal.aborted) return unavailable();
    const captured = await OwnerFileClinicVocabulary.captureForReview(config);
    if (!captured.ok) return captured;
    const state = await captured.value.reviewState(signal);
    // The first release edits an existing owner's approval only. A different
    // owner requires a separately provisioned current clinic approval.
    if (!state.ok || state.value.approval.approverRef !== actor.actorRef) return unavailable();
    const proposal = proposeClinicVocabulary(state.value.catalogue, state.value.approval.vocabulary);
    return proposal.ok ? ok({ captured: captured.value, state: state.value, proposal: proposal.value }) : proposal;
  }
  async propose(actor: HostActor, signal: AbortSignal): Promise<Result<VocabularyProposal & Readonly<{ expectedBinding: string }>, Failure>> {
    try {
      const found = await this.#snapshot(actor, signal);
      return found.ok ? ok({ ...found.value.proposal, expectedBinding: found.value.state.binding }) : found;
    } catch { return unavailable(); }
  }
  async save(actor: HostActor, input: Review, signal: AbortSignal,
    stillAuthorized?: () => Promise<boolean>): Promise<Result<ClinicVocabulary, Failure>> {
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    let temporary: string | undefined;
    const config = this.#config, lockPath = config.path + ".review-lock";
    try {
      actor = structuredClone(actor); input = structuredClone(input);
      if (!input || Object.keys(input).sort().join(",") !== "catalogueHash,expectedBinding,expectedRevision,manualPublicTerms,selectedTerms" ||
          !isAbsolute(config.path) || typeof process.getuid !== "function" || signal.aborted) return unavailable();
      const parent = dirname(config.path), stat = await lstat(parent);
      if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 ||
          await realpath(parent) !== parent) return unavailable();
      try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) { return error && typeof error === "object" && "code" in error && error.code === "EEXIST"
        ? err({ kind: "reviewBusy" }) : unavailable(); }
      const found = await this.#snapshot(actor, signal);
      if (!found.ok) return found;
      const { state } = found.value;
      if (input.expectedBinding !== state.binding) return err({ kind: "staleVocabulary" });
      const reviewed = reviewClinicVocabulary(state.catalogue, state.approval.vocabulary, {
        expectedRevision: input.expectedRevision, catalogueHash: input.catalogueHash,
        manualPublicTerms: input.manualPublicTerms, selectedTerms: input.selectedTerms });
      if (!reviewed.ok) return reviewed;
      const now = (config.clock ?? (() => new Date().toISOString()))();
      if (approvalInstant(now) === undefined || Date.parse(now) >= Date.parse(state.approval.effectiveUntil)) return unavailable();
      const row = { ...state.approval, vocabulary: reviewed.value, revision: "vocabulary-" + reviewed.value.version,
        approvedAt: now, effectiveFrom: now };
      const bytes = Buffer.from(JSON.stringify(row) + "\n");
      if (bytes.length > 8192) return err({ kind: "invalidVocabulary" });
      temporary = config.path + ".review-" + randomUUID();
      const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
      // Authentication may suspend independently of the owner/source reads.
      // Recheck the captured approval after it so a withdrawal cannot be revived.
      if (stillAuthorized && !await awaitUntilAbort(Promise.resolve().then(stillAuthorized), signal)) return unavailable();
      const again = await found.value.captured.reviewState(signal);
      if (!again.ok) return again;
      const fresh = proposeClinicVocabulary(again.value.catalogue, again.value.approval.vocabulary);
      if (!fresh.ok || fresh.value.catalogueHash !== input.catalogueHash || signal.aborted) return err({ kind: "staleVocabulary" });
      if (signal.aborted) return unavailable();
      await rename(temporary, config.path); temporary = undefined;
      const folder = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await folder.sync(); } finally { await folder.close(); }
      return reviewed;
    } catch { return unavailable(); }
    finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
      if (lock) {
        const original = await lock.stat().catch(() => undefined), current = await lstat(lockPath).catch(() => undefined);
        if (original && current && original.dev === current.dev && original.ino === current.ino) await unlink(lockPath).catch(() => undefined);
        await lock.close().catch(() => undefined);
      }
    }
  }
}
