import { randomUUID } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope } from "../core/model.ts";
import type { PatientProofHost } from "../core/host.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { sameScope } from "./appointment-change-authority.ts";

type Config = Readonly<{ scope: LocationScope; patientId: string; signal: AbortSignal;
  clock(): string; current(signal: AbortSignal): Promise<boolean> }>;
const unavailable = () => err({ kind: "unavailable" as const, target: "patient" as const });

/** Internal exact read capability from independently authorized financial-owner
 * context. It is not caller verification, a reusable patient grant or mutation
 * consent. Concrete native adapters retain this capability only during a read. */
export function financialClinicalNativeRead(config: Config): Readonly<{ reference: string; proof: PatientProofHost }> {
  const c = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
  const began = Date.parse(c.clock()), reference = `financial-clinical-read:${randomUUID()}`;
  const lifetime = AbortSignal.any([c.signal, AbortSignal.timeout(30_000)]);
  const currentTime = (supplied: string) => {
    const at = Date.parse(c.clock()), query = Date.parse(supplied);
    return Number.isFinite(began) && Number.isFinite(at) && Number.isFinite(query) && at >= began &&
      at < began + 30_000 && Math.abs(query - at) <= 30_000;
  };
  const verifyPatient: PatientProofHost["verifyPatient"] = async (scope, ref, supplied, signal) => {
    const stop = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
    try {
      if (stop.aborted || ref !== reference || !sameScope(scope, c.scope) || !/^[1-9][0-9]{0,18}$/.test(c.patientId) || !currentTime(supplied) ||
          await awaitUntilAbort(c.current(stop), stop) !== true || stop.aborted || !currentTime(supplied)) return unavailable();
      return ok({ scope: { ...c.scope }, patientRef: c.patientId, verificationRef: reference,
        expiresAt: new Date(began + 180_000).toISOString() });
    } catch { return unavailable(); }
  };
  return Object.freeze({ reference, proof: Object.freeze({ verifyPatient }) });
}
