import type { Result } from "../core/model.ts";

/** Trusted account owner port, outside caller/model commands. The owner provisions every credential alias. */
export interface ClinikoContactRevisionReader {
  matches(tenantId: string, credentialFingerprint: string): boolean;
  read(credentialFingerprint: string): Promise<Result<Readonly<{ version: number; blocked: boolean }>,
    Readonly<{ kind: "invalidInput" | "storageFailure" | "contactChanged" }>>>;
}
export interface ClinikoContactRevisionOwner extends ClinikoContactRevisionReader {
  /** Durable fence before a possible native write. An uncertain outcome must retain it. */
  begin(correctionRef?: string): Promise<Result<string, Readonly<{ kind: "invalidInput" | "storageFailure" | "contactChanged" }>>>;
  /** Consume only this change after exact native inspection; other pending changes remain blocked. */
  complete(changeRef: string): Promise<Result<true, Readonly<{ kind: "invalidInput" | "storageFailure" | "contactChanged" }>>>;
}
