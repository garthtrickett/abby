# Current-main engineering reconciliation, 6 November 2026

This checks the selected engineering evidence in the [execution order](EXECUTION_ORDER.md), [thirteen-gap plan](THIRTEEN_GAP_IMPLEMENTATION.md), and [Karen reuse audit](KAREN_TO_ABBY_REUSE_AUDIT.md) against actual merged main `463a4ac3104c329f1dd39d2ed08f6e478aeddeea` (PR #648). It does not close a whole gap or authorize clinic traffic. The private machine-readable receipt is `/home/gust/.local/state/abby-current-plan-20261106/current-main-selected-plan-audit-v1.json`.

The predecessor full-scope audit at main `5d6e7fa5` selected 143 exact source pins and passing witnesses for the earlier gaps, class/pass stage, and Karen R01–R28. On current main, 142 pins are byte-identical. The sole changed pin is `phase-2/PRODUCT_FACTS_FINGERPRINTS.json`, whose speech-gate document hash was updated in the reviewed PR #648. The current main has only that and seven voice-validation files beyond the predecessor tree. All 93 selected earlier-gap, 131 class/pass, and 281 reuse witness titles are present as passing tests in the independently hashed current-main text and PostgreSQL job logs. These groups overlap; they are not added together as a test total. The current-main run `41999130934` passed typecheck, browser, text (6,040 passed, 286 existing mode skips), and PostgreSQL (7,457 passed, one existing mode skip), plus six ordered controls in each applicable job.

| Gap | Current selected engineering evidence | Still separate |
| --- | --- | --- |
| 1 | Five compiled receptionist operations. | Clinic policy and deployment acceptance. |
| 2 | Three current permission, authority, and failed-delivery witnesses. | Approved clinic policy and real mailbox receipt. |
| 3 | Four staff request outcome witnesses. | Human owner, deployed monitoring, and never-admitted call inventory. |
| 4 | Fresh synthesis comparison and historical noisy transcription cohorts. | Synthetic acoustic gate fails; representative listener and clinic tests remain. |
| 5 | Two approved service and first-time selection witnesses. | Actual clinic catalogue and multi-location acceptance. |
| 6 | Seven online, offline, recurring, and late-conflict witnesses. | Real clinic calendar semantics. |
| 7 | Two exact practitioner-move and response-loss witnesses. | Acoustic and clinic acceptance. |
| 8 | Four registration/address/permission witnesses. | Clinic-specific field mapping and actual mail. |
| 9 | Nine self/related-person task and privacy witnesses. | Unselected combinations and real guardian authority. |
| 10 | Nine selected class/pass witnesses plus 131 stage-seven titles across seven staged-movement requirements. | Real pass/financial provisioning and operator acceptance. |
| 11 | Five selected signed payment/expiry witnesses. | Clinic fees and records, actual financial/sender acceptance, and the owner-deferred cash/bank invoice. |
| 12 | Seven selected outbound/contact-review witnesses; [clinic staff review](OUTBOUND_STAFF_REVIEW.md) is the chosen path when private or unclear audio prevents a reliable result. | Real provider inventory and clinic acceptance; contact remains held. Automated whole-call no-stop classification is unselected and unproven. |
| 13 | Thirty-six memo sender-loss/recovery/privacy witnesses. | Approved wording, native author/viewers, retention, and staff inspection. |

This transfer found no new independent code defect in those selected current-main scopes. It is not exhaustive proof of every operation, real clinic grant, acoustic condition, or stage exit. Earlier red outcomes and the failed speech gate remain failed evidence. The original audited Karen revision `34a642be` is unavailable; the uploaded reference supports independent engineering but supplies no deletion clearance. The next independent work is the [voice limit analysis](../phase-1/VOICE_VALIDATION_2026-11-05.md) and a current-source [clinic trial checklist](CLINIC_TRIAL_CHECKLIST_2026-11-06.md). Human acceptance and production activation remain separate.
