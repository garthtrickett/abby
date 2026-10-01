/** Public, patient-free projection of the owner-only speech evaluation reports. */
export type SpeechGatePublicStatus = Readonly<{
  syntheticCandidateGate: "pass" | "fail";
  representativeCallGate: "notRun";
  releaseGate: "unverified";
  checks: readonly Readonly<{ name: "telephony" | "noise" | "safety" | "speech";
    status: "pass" | "fail" }>[];
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function publicSpeechGateStatus(value: unknown): SpeechGatePublicStatus | undefined {
  const status = record(value);
  if (!status || status.kind !== "speechGateStatus" ||
      (status.syntheticCandidateGate !== "pass" && status.syntheticCandidateGate !== "fail") ||
      status.representativeCallGate !== "notRun" || status.releaseGate !== "unverified" ||
      !Array.isArray(status.checks) || status.checks.length !== 4) return undefined;
  const names = ["telephony", "noise", "safety", "speech"] as const;
  const checks = status.checks.map(record);
  if (checks.some((check, index) => check?.name !== names[index] ||
      (check?.status !== "pass" && check?.status !== "fail")) ||
      (status.syntheticCandidateGate === "pass") !== checks.every(check => check?.status === "pass")) return undefined;
  return { syntheticCandidateGate: status.syntheticCandidateGate,
    representativeCallGate: "notRun", releaseGate: "unverified",
    checks: checks.map((check, index) => ({ name: names[index]!, status: check!.status as "pass" | "fail" })) };
}
