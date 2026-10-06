/** These public descriptions do not grant appointment-type or fee authority. */
export const publicInformationTopics = ["serviceGuidance", "priceAndFees"] as const;
export type PublicInformationTopic = typeof publicInformationTopics[number];
export function publicInformationTopic(refs: readonly string[]): PublicInformationTopic | undefined {
  return Array.isArray(refs) && refs.length === 1 ? publicInformationTopics.find(topic => refs[0] === `clinic-public-${topic}`) : undefined;
}
export function publicInformationUnavailable(topic: PublicInformationTopic): string {
  return topic === "serviceGuidance"
    ? "I can't verify approved service descriptions right now, and I can't choose an appointment type from symptoms. Please contact clinic staff for guidance. I haven't selected an appointment type or changed an appointment for this request."
    : "I can't verify the current price or cancellation fee for your visit. Moving an appointment does not establish that a cancellation fee is waived. Please contact the clinic to confirm costs and fees. I haven't changed an appointment for this request.";
}
