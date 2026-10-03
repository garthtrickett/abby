# Agent appointment proposals: maintainability review

## Scope — 2026-10-03

Direct review using the `thermo-nuclear-code-quality-review` criteria of the gateway/catalogue changes, fixtures, registered E2E-261 and specification updates. This review does not replace final release gates or prove real provider/carrier behavior.

## Findings and resolutions

1. **Keep one clinical implementation.** Both new commands invoke the existing reception methods, which own captured policy, session checks and host evidence. The gateway returns the existing redacted progress. No agent-specific transition, duplicated provider writer, or code importing standalone authentication into the core is introduced.
2. **Make the interface exact.** Appointment selection is discriminated by operation; a replacement offer belongs only to rescheduling. Intake accepts a draft reference. Schemas reject caller-supplied authority/confirmation and require current session identity. Typed catalogue preconditions describe execution requirements; the compiler rejects undeclared metadata.
3. **Test through the actual interfaces.** Eleven gateway cases and two PostgreSQL cases use the canonical dispatcher, real admission/action/effect logic and actual storage. Six voice cases use an actual attached VoiceSession and its playback/transcript interfaces. They distinguish proposal, played details, caller affirmation and commit. Synthetic playback is identified explicitly rather than described as signed ingress or carrier proof.
4. **Preserve strict storage and recovery differences.** Raw toggles do not grant standalone patient actions. Database and backup scans prove no durable private call/patient/proof/draft/consent/caller fields; disposal loses standalone state. Embedded tests prove reconnect and replay behavior and each operation's write stop/resume denial without claiming real provider idempotency.
5. **Register every new proposal.** Manifest 1.71 maps both commands and affected setting/stop capabilities to E2E-261. The contract now requires executable evidence for proposal-only capabilities as well as policy changes. Its scenario count and technical-design table remain exact. Existing manifest formatting is preserved.

## Conclusion

No substantive maintainability finding remains in this direct pass. The production change is confined to the existing catalogue and dispatcher, below the giant-file threshold. Clinical rules, privacy limits and effect ownership stay in their existing modules. Focused registered-source validation passed 36 checks without skips, and current voice/gateway TypeScript proof passed 17 cases without skips. Initial fixture, type and migration-command failures remain recorded with their corrections in [the proposal contract](AGENT_APPOINTMENT_PROPOSALS.md).

Broad regression and complete parallel isolation passed on `558b66a`: typecheck, 724 memory, 1,197 PostgreSQL and 72 browser checks, plus 517 mapped Node and 59 mapped browser cases alone and in both parallel orders. Expected broad storage/live skips and zero mapped skips remain explicit in the contract. The final documentation audit adds a direct overview version/count check after reproducing its stale metadata; this introduces no production change. Publication-source metadata validation remains required. Provider authority, real signed/carrier delivery and buyer integration retain separate gates.
