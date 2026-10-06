import type { AppointmentHost } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { AppointmentChangeAuthority } from "./appointment-change-authority.ts";
import { ClinikoAppointmentSelection } from "./cliniko-appointment-selection.ts";
import type { ClinikoAppointmentSelectionConfig } from "./cliniko-appointment-selection.ts";
import { OwnerFileCancellationPolicy } from "./owner-file-cancellation-policy.ts";

export type ClinikoCancellationAuthorityConfig = Omit<ClinikoAppointmentSelectionConfig, "policy"> & Readonly<{ policy: OwnerFileCancellationPolicy }>;
/** Cancellation adapter for the shared protected appointment-selection boundary. */
export class ClinikoCancellationAuthority implements AppointmentChangeAuthority, AppointmentHost {
  readonly #source: ClinikoAppointmentSelection;
  private constructor(source: ClinikoAppointmentSelection) { this.#source = source; }
  static create(config: ClinikoCancellationAuthorityConfig, fetchPort: typeof fetch = fetch):
    Result<ClinikoCancellationAuthority, Readonly<{ kind: "invalidConfig" }>> {
    try {
      if (!(config.policy instanceof OwnerFileCancellationPolicy)) return err({ kind: "invalidConfig" });
      const source = ClinikoAppointmentSelection.create(config, fetchPort);
      return source.ok ? ok(new ClinikoCancellationAuthority(source.value)) : source;
    } catch { return err({ kind: "invalidConfig" }); }
  }
  list(...args: Parameters<ClinikoAppointmentSelection["list"]>) { return this.#source.list(...args); }
  select(...args: Parameters<ClinikoAppointmentSelection["select"]>) { return this.#source.select(...args); }
  clearSelection(): void { this.#source.clearSelection(); }
  async resolve(query: Parameters<AppointmentChangeAuthority["resolve"]>[0]): ReturnType<AppointmentChangeAuthority["resolve"]> {
    if (query.kind !== "cancel") return err({ kind: "unavailable", target: "appointment" });
    const result = await this.#source.resolveTarget(query);
    return result.ok && result.value.cancellationReason !== undefined ?
      ok({ ...result.value, kind: "cancel", cancellationReason: result.value.cancellationReason }) : err({ kind: "unavailable", target: "appointment" });
  }
  dispose(): void { this.#source.dispose(); }
}
