import type { CallPolicy, LocationScope } from "../core/model.ts";
import { referenceDefaultPolicy } from "../reference/policy-store.ts";

/** Standalone settings start without the reference host's synthetic greeting. */
export function standaloneDefaultPolicy(scope: LocationScope): CallPolicy {
  const { greeting, ...policy } = referenceDefaultPolicy(scope);
  void greeting;
  return policy;
}
