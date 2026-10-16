import type { LocationScope } from "../../src/core/model.ts";
import type { ClassMoveRecoveryRequest } from "../../src/standalone/cliniko-class-move-recovery.ts";

/** Private isolated-fixture bindings, never a caller proof or a public command. */
export type ClassMoveColdContext = Readonly<{ scope: LocationScope; proxy: string; sourcePath: string; destinationPath: string; movePath: string;
  accountPath: string; actorRef: string; policyVersion: string; businessId: string; recallTypeId: string; timeZone: string;
  source: Readonly<{ practitionerId: string; appointmentTypeId: string }>;
  destination: Readonly<{ practitionerId: string; appointmentTypeId: string }>;
  now: string; request: ClassMoveRecoveryRequest;
  signedFixture?: Readonly<{ resolutionAllowed: boolean }> }>;
