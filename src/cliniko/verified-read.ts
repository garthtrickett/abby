import type { PatientProofHost } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, VerifiedPatient } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

type Context = Readonly<{ proof: PatientProofHost; scope: LocationScope; verificationRef: string; clock: () => string }>;
const sameScope = (a: LocationScope, b: LocationScope) => a?.tenantId === b?.tenantId && a?.clinicId === b?.clinicId && a?.locationId === b?.locationId;

/** One private, read-only compound observation. Actual operation-bound patient
 * authority/native contact is verified before and after the entire group. The
 * scoped proof is valid only inside this callback; it is never a write permit.
 * The callback must not publish/persist protected results or mutate provider
 * records. Ordinary budget bookkeeping and private permission checks remain.
 * Internal readers retain their own source/rule/permission/snapshot checks.
 * A revoked/changed proof discards the entire observation, including early reads. */
export async function withVerifiedClinikoRead<T>(context: Context, external: AbortSignal,
  read: (proof: PatientProofHost, signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  if (!(external instanceof AbortSignal) || external.aborted || typeof read !== "function") return undefined;
  if (!context?.scope || ![context.scope.tenantId, context.scope.clinicId, context.scope.locationId, context.verificationRef]
    .every(v => typeof v === "string" && !!v.trim() && v.length <= 256) || typeof context.clock !== "function" || typeof context.proof?.verifyPatient !== "function") return undefined;
  const signal = AbortSignal.any([external, AbortSignal.timeout(15000)]);
  let open = true;
  try {
    const valid = (p: VerifiedPatient | undefined) => !!p && sameScope(p.scope, context.scope) && p.verificationRef === context.verificationRef &&
      typeof p.patientRef === "string" && /^[1-9][0-9]{0,18}$/.test(p.patientRef) && Number.isFinite(Date.parse(context.clock())) &&
      Number.isFinite(Date.parse(p.expiresAt)) && Date.parse(p.expiresAt) > Date.parse(context.clock()) + 120000;
    const first = await awaitUntilAbort(context.proof.verifyPatient(context.scope, context.verificationRef, context.clock(), signal), signal);
    if (!first?.ok || !valid(first.value) || signal.aborted) return undefined;
    const patient = structuredClone(first.value);
    const scoped: PatientProofHost = { verifyPatient: async (scope, ref, now, stop) => {
      if (!open || signal.aborted || stop?.aborted || !sameScope(scope, context.scope) || ref !== context.verificationRef ||
        !Number.isFinite(Date.parse(now)) || Math.abs(Date.parse(now) - Date.parse(context.clock())) > 30000 || !valid(patient)) return err({ kind: "notFound", target: "patient" });
      return ok({ scope: { ...context.scope }, patientRef: patient.patientRef, verificationRef: patient.verificationRef, expiresAt: patient.expiresAt });
    } };
    const found = await awaitUntilAbort(Promise.resolve().then(() => read(scoped, signal)), signal);
    open = false;
    if (signal.aborted) return undefined;
    const last = await awaitUntilAbort(context.proof.verifyPatient(context.scope, context.verificationRef, context.clock(), signal), signal);
    return last?.ok && valid(last.value) && last.value.patientRef === patient.patientRef && last.value.expiresAt === patient.expiresAt && !signal.aborted ? found : undefined;
  } catch { return undefined; }
  finally { open = false; }
}
