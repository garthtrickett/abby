import type { LocationScope } from "../core/model.ts";
import { isClinikoRequestBudget } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";

export type ClinikoCostBinding = Readonly<{ scope: Pick<LocationScope, "tenantId" | "clinicId">;
  credentialFingerprint: string; budget: ClinikoRequestBudget }>;
type Declaration = Readonly<{ binding: ClinikoCostBinding; maximum: number }>;
const declarations = new WeakMap<object, Declaration>();

/** Trusted composition declaration for one callback invocation, including all
 * its transitive same-account native requests. This is a cost contract, never
 * patient/write permission or a substitute for actual shared-budget claims.
 * Unknown callbacks have no ceiling. The caller must bind methods that need a
 * receiver; the returned function preserves the supplied callback's interface. */
export function declareClinikoRequestCost<Args extends unknown[], Value>(port: (...args: Args) => Value,
  binding: ClinikoCostBinding, maximum: number): (...args: Args) => Value {
  if (typeof port !== "function" || !binding?.scope ||
      ![binding.scope.tenantId, binding.scope.clinicId].every(value => typeof value === "string" && !!value.trim() && value.length <= 256) ||
      !/^[a-f0-9]{64}$/.test(binding.credentialFingerprint) || !isClinikoRequestBudget(binding.budget) ||
      !Number.isSafeInteger(maximum) || maximum < 0 || maximum > 200) throw new TypeError("invalid Cliniko request cost declaration");
  const wrapped = (...args: Args): Value => port(...args);
  declarations.set(wrapped, Object.freeze({ binding: Object.freeze({ scope: Object.freeze({ tenantId: binding.scope.tenantId,
    clinicId: binding.scope.clinicId }), credentialFingerprint: binding.credentialFingerprint, budget: binding.budget }), maximum }));
  return wrapped;
}

/** Read only the declaration for this exact callback/account/budget. A lower
 * bound, function name, caller/model field or another account cannot supply it. */
export function clinikoRequestCeiling(port: unknown, binding: ClinikoCostBinding): number | undefined {
  const declared = typeof port === "function" ? declarations.get(port) : undefined;
  return declared && binding?.scope && declared.binding.budget === binding.budget &&
    declared.binding.credentialFingerprint === binding.credentialFingerprint &&
    declared.binding.scope.tenantId === binding.scope.tenantId && declared.binding.scope.clinicId === binding.scope.clinicId
    ? declared.maximum : undefined;
}

/** Forwarders may copy a ceiling only when they invoke the source at most once
 * and add no native I/O. More expensive compositions need a separate bound. */
export function inheritClinikoRequestCost<Args extends unknown[], Value>(forward: (...args: Args) => Value,
  source: unknown): (...args: Args) => Value {
  const declared = typeof source === "function" ? declarations.get(source) : undefined;
  return declared ? declareClinikoRequestCost(forward, declared.binding, declared.maximum) : forward;
}
