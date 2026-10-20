# Native shared-number stop observation

`ClinikoOutboundNumberStops` checks an exact requested number against the clinic's explicitly approved current and retired native contact-review sources. A stop attached to another patient or location still blocks the number. This read-only component returns a bounded native observation, not permission to call or proof that no provider stop awaits retention. It is not yet wired into the launcher.

## Source coverage and permissions

A current owner-only `OwnerFileOutboundContactAccount` file contains clinic-admin approval, non-patient source-role metadata and explicit credential aliases. Its coverage declaration must include all current and retired authoritative voice-contact sources. Up to eight source roles and eight aliases are accepted; each role retains an independent current source definition. Current administrator membership, scope, effective interval, whole-operation deadline and repeated file checks remain necessary. Captured policy, clock and authority methods cannot be replaced during an invocation.

Read authority is separate from this metadata. Independent preliminary/decoded exact-record, whole-account collection, head, reconsent and exact-number stop-resolution grants are checked after waits and again before return. These grants cover the full returned private bodies, including unrelated native records. A patient contact read or financial grant cannot supply broad account permission.

The broad collection uses documented `archived_at:*`, ascending ID ordering and stable pagination. No undocumented type or telephone filter is sent. Local selection accepts only the approved contact-source roles; an observed contact-review family marker under an unlisted role or unsupported version refuses. The marker is a refusal signal, never validity or approval evidence. The collection remains bounded to 500 native rows and 50 selected reviews. Every selected record is independently decoded, authorized and reread, including closed or archived history; a complete second collection and current policy/grant checks precede disclosure. Native IDs and timestamps do not choose lineage heads.

## Restrictive decisions survive

A matching stop remains restrictive after closure, archival or expiry. Changing a patient's number cannot clear the original number. Clearance requires a current same-number/purpose eligible head, independently approved reconsent, and a separate exact-number resolution for each earlier matching stop. A different patient's unresolved stop still blocks. Unknown, missing, forked, changed, unsupported, over-bound or denied evidence cannot become a clear result. Positive head expiry is checked after all waits.

The public result contains only disposition, observation time, request digest and account binding. Cross-patient histories, phone values and native references remain private transient data. No SQL connection, private local cache, patient queue, new schema, producer, native write or transport action is introduced. The unchanged shared physical account budget applies to every actual GET and propagates real429 cooldowns.

## Boundaries still open

`noRecordedStopObserved` means only that this bounded observation found no unresolved native stop under its declared coverage and grants. It does not establish complete provider reporting, absence of an unretained stop, patient verification, consent, launch authority, atomic native history or full producer/restore qualification. The human coverage declaration and migration process remain necessary; this is not protection against arbitrary malicious native deletion or rewriting. Retired roles and aliases cannot be dropped through an unqualified migration. Cross-policy/credential lineage reconciliation remains explicit.

Durable unresolved-stop admission, authenticated real provider recovery, concrete Twilio/Abby and future Vapi adapters, verified clinical callback and actual clinic/provider/restore acceptance remain unfinished. No default route or activation follows. Karen's `server/src/services/ob/obDncService.ts` in `/home/gust/code/karen-website-dev` is a useful reference for keeping unresolved call-stop truth restrictive when final DNC retention fails; Abby cannot copy its local patient-bearing call-log storage.

See [outbound responsibilities](OUTBOUND_SICK_DAY_CONTRACT.md) and [qualification evidence](EXECUTION_PROGRESS.md#native-shared-number-stop-observation-19-october-2026).
