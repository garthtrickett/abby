import type { RequestBoundary } from "../core/request-boundary.ts";

/** Exact public requests only. Other turns retain ordinary protected
 * interpretation; these routing cues never issue patient authority. */
const patterns: readonly Readonly<{ reason: RequestBoundary; pattern: RegExp }>[] = [
  { reason: "minorIntake", pattern: /^(?:i (?:want|need|would like) (?:a |an )?(?:first visit|first appointment|new patient appointment) for (?:my|our) (?:young |little )?(?:child|son|daughter|baby)|(?:please |can you |could you )?(?:register|book) (?:my|our) (?:young |little )?(?:child|son|daughter|baby)(?: for (?:a |their )?first (?:visit|appointment))?)(?: please)?$/ },
  { reason: "proxyPatient", pattern: /^(?:this is for my (?:partner|husband|wife|parent|friend) (?:please )?(?:move|cancel|book|reschedule) their appointment|(?:please |can you |could you )?(?:book|move|cancel|reschedule) (?:an appointment for my (?:partner|husband|wife|parent|friend)|my (?:partner|husband|wife|parent|friend)'s (?:appointment|visit)|both my (?:appointment|visit) and my (?:partner|husband|wife|parent|friend)'s))(?: please)?$/ },
  { reason: "jointPractitioners", pattern: /^(?:i (?:need|want|would like)|can i have|could i have) (?:two|several|multiple) (?:clinicians|practitioners|therapists|physios)(?: free| available)? (?:together|at the same time) for (?:the same|one|a single) (?:visit|appointment)(?: please)?$/ },
  { reason: "groupClass", pattern: /^(?:i (?:cannot|can't|can not) attend (?:the|my) (?:group )?class(?: tonight|today|tomorrow)?|(?:please |can you |could you )?(?:book|cancel|move|reschedule) (?:my |the |a )?(?:group class|class attendance)(?: tonight|today|tomorrow)?)(?: please)?$/ },
  { reason: "groupClass", pattern: /^(?:please |can you |could you )?(?:remove|withdraw) me from (?:the|my|this evening's|today's|tonight's) (?:pilates|yoga|exercise) (?:class|group|cohort)(?: please)?$/ },
];
export function requestBoundaryLanguage(text: string): RequestBoundary | undefined {
  const value = text.toLowerCase().replace(/[’]/g, "'").replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim();
  return patterns.find(item => item.pattern.test(value))?.reason;
}
