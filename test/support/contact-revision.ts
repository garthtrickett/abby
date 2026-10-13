import { randomUUID } from "node:crypto";
import { err, ok } from "../../src/core/model.ts";
import type { ClinikoContactRevisionOwner } from "../../src/cliniko/contact-revision.ts";

/** Synthetic test owner. Production runner uses the PostgreSQL store. */
export class SyntheticContactRevision implements ClinikoContactRevisionOwner {
  #version = 0;
  readonly #pending = new Set<string>();
  readonly #used = new Set<string>();
  readonly tenantId: string;
  readonly fingerprints: readonly string[];
  constructor(tenantId: string, fingerprints: readonly string[]) { this.tenantId = tenantId; this.fingerprints = [...fingerprints]; }
  matches(tenantId: string, fingerprint: string) { return tenantId === this.tenantId && this.fingerprints.includes(fingerprint); }
  async read(fingerprint: string): ReturnType<ClinikoContactRevisionOwner["read"]> {
    return this.matches(this.tenantId, fingerprint) ? ok({ version: this.#version, blocked: this.#pending.size > 0 }) : err({ kind: "invalidInput" as const });
  }
  async begin(correctionRef?: string): ReturnType<ClinikoContactRevisionOwner["begin"]> {
    const ref = correctionRef ?? randomUUID();
    if (this.#used.has(ref)) return err({ kind: "contactChanged" });
    this.#used.add(ref); this.#pending.add(ref); this.#version++; return ok(ref);
  }
  async complete(ref: string): ReturnType<ClinikoContactRevisionOwner["complete"]> {
    if (!this.#pending.delete(ref)) return err({ kind: "contactChanged" as const });
    this.#version++; return ok(true as const);
  }
}
