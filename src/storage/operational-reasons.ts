/** Closed reason codes for standalone operational rows. No patient text belongs here. */
export function validWriteStopReason(stopped: boolean, value: unknown): boolean {
  return stopped
    ? value === "cutover" || value === "operatorStop"
    : value === "operatorResume";
}

export function validPortabilityFenceReason(action: "freeze" | "release", value: unknown): boolean {
  return value === (action === "freeze" ? "cutoverFreeze" : "cutoverRelease");
}
