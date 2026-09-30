# Caller verification boundary for standalone Cliniko

**Status:** engineering contract for synthetic tests; no clinic has activated a patient-specific caller path. This document refines [D-01](DECISIONS.md) and [B3](../NO_TWILIO_NUMBER_WORK_PLAN.md), and does not itself authorize appointment disclosure or mutation.

## What clinic approval means

An authorized operator for the clinic and location accepts a versioned, patient-facing verification policy and demonstrates that the clinic can carry out its human fallback. This is an operational rollout decision, not Cliniko vendor approval or a certificate. Abby's product owner may set generic safe defaults and engineers may test them with synthetic patients. A demo account cannot approve another clinic's handling of real callers.

The activation record must name the clinic and location, approver and role, policy version and date, exact verification method and allowed attempts, permitted disclosures and actions, proxy-caller rules, caller wording, and a rehearsal result. If a staff fallback is enabled, it must also name its owner and backup. Configuration changes that affect any of these require a new version and rehearsal. If the record is missing, stale, or outside its scope, patient-specific capability stays disabled.

## Boundary before proof

1. Bind the call to exactly one tenant, clinic and location. The signed carrier event supplies a *presented* phone number; it does not authenticate the speaker. An absent or invalid number is an anonymous call.
2. A fresh, complete clinic-scoped phone index can return candidate Cliniko patient IDs. Re-read each candidate by ID to confirm its current phone. A stale, incomplete, ambiguous, or unavailable lookup grants no access. Candidate IDs, candidate count, names, dates of birth and whether a record exists must not be spoken to the caller or sent to the model as proof.
3. Before verification, Abby may say only approved general clinic facts and that it cannot access or change a personal appointment yet. It must not confirm or deny a patient's existence, appointment, contact details, or the existence of a shared-number match.
4. Exact email and date of birth filters may help **find a candidate**. Knowing those attributes, or calling from a matching number, is not sufficient proof. A verifier approved for the clinic must separately establish the caller's authority. This avoids treating commonly known personal attributes as a secret; [NIST's digital identity guidance](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/) does not recognize knowledge-based security questions as an acceptable authenticator. This is design guidance, not a claim that NIST rules directly govern the clinic.

## Verification contract to implement

The verifier is a trusted host capability, never a model instruction or caller-supplied patient ID. It takes the live call's bound scope, fresh candidate set, clinic policy version, and a bounded verification interaction. It returns either a denial reason or one patient ID whose identity **and authority for the requested action** it established. Only then may the host mint an opaque, unpredictable proof reference bound to that call, scope, patient ID, permitted operations, policy version and expiry. The proof must live only in the active process in standalone mode, expire within five minutes, be revoked on disconnect, and fail closed after process loss. An appointment reader or writer must revalidate that exact proof and its own operation permission before touching protected appointment data. A proof for one patient, location, call or operation never authorizes another.

An implementation may use a clinic-approved independent channel or a verified staff handoff. The initial standalone release has **no approved automated verification method**. Do not promote email plus birth date, a phone match, or an LLM's confidence to one. Any future automated method needs a process-independent abuse limit or equivalent host control: an in-memory per-call attempt counter alone resets after restart and cannot defend repeated calls.

| Situation | Required outcome before an approved method exists |
| --- | --- |
| One current phone candidate | General wording only; no proof from the match. |
| Shared number, several candidates | Ask no question that reveals a candidate; use approved staff verification if available. |
| Spoofed, anonymous, missing, stale or unavailable number/index | No protected read or write; use the same generic response. |
| Wrong, partial or ambiguous answers; caller refuses | No proof; stop after the policy's bounded attempts. Never disclose which answer failed. |
| Caller acts for someone else | No automatic access. The clinic must define how it checks representative authority and which actions it permits. |
| Disconnect, expiry, process loss or emergency policy disable | Revoke or reject the proof; no replay of a possible mutation. |
| Staff workflow unavailable | Explain that Abby cannot handle the personal request now, without promising a follow-up task. |

The product's patient-specific handoff and booking capability gates remain independent. Passing verification does not enable a Cliniko appointment write, a recall, or a claim that staff will follow up.

## Synthetic acceptance cases

The implementation must test a signed, location-bound standalone call and the protected appointment reader/writer boundary together. For spoofed, shared, stale, anonymous and failed-proof calls, assert **zero appointment-detail Cliniko reads and appointment writes**, no patient fact in spoken text or model context, and no patient-specific durable record. The bounded patient-by-ID re-read used to check a phone candidate is allowed before proof; it does not permit appointment access. Also test a synthetic authorized verifier that selects exactly one candidate, a wrong-patient proof, cross-tenant/location/call reuse, expiry, withdrawal, emergency policy disable, verifier timeout, and disconnect while verification is pending. Enabled and disabled policy settings need separate whole-call cases. Until these pass, B3's engineering exit remains open; until a clinic completes the activation record, the live capability remains off.
