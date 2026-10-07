import type { RequestBoundary } from "../core/request-boundary.ts";

/** Exact public requests only. Other turns retain ordinary protected
 * interpretation; these routing cues never issue patient authority. */
const patterns: readonly Readonly<{ reason: RequestBoundary; pattern: RegExp }>[] = [
  { reason: "groupClass", pattern: /^(?:can you |could you |please )?(?:book|cancel|move|reschedule|switch) (?:(?:me (?:into|onto) )?(?:my|the|a) )?(?:pilates|mat|gym) class(?: tonight|today|tomorrow)?(?: please)?$/ },
  { reason: "groupClass", pattern: /^can you switch my mat class from (?:[01]\d|2[0-3]):[0-5]\d to (?:[01]\d|2[0-3]):[0-5]\d tonight$/ },
  { reason: "groupClass", pattern: /^i have a membership pass can you book the (?:[01]\d|2[0-3]):[0-5]\d mat class$/ },
  { reason: "groupClass", pattern: /^[a-z][a-z -]{0,79} will not attend (?:gym|pilates|mat) class today$/ },
  { reason: "groupClass", pattern: /^(?:can you switch my class tonight|i already have a mat pass book the pilates class tonight)$/ },
  { reason: "externalAppointmentChange", pattern: /^(?:i|you|the clinic|the practitioner) (?:(?:have|had) )?(?:already )?(?:cancelled|canceled|changed|moved|rescheduled|booked) (?:my|the) appointment(?: for (?:today|tomorrow|\d{4}-\d{2}-\d{2}))? (?:online|on (?:the|your) (?:website|app)|directly with (?:the )?(?:provider|practitioner|clinic)|(?:on|during) (?:my|the) (?:last|previous|earlier) call)$/ },
  { reason: "externalAppointmentChange", pattern: /^i started booking (?:my|the) appointment (?:online|on (?:the|your) (?:website|app))$/ },
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
