# Outbound call admission

The incoming `Admission.dialedNumber` is the public clinic number reached by an incoming call. It must not be filled with an outgoing patient's destination.

`Admission` now distinguishes the unchanged incoming shape from `OutboundAdmission`: explicit `direction: "outbound"`, the public `clinicNumber`, account/provider call identifiers, acceptance time and deadline. The call ledger validates exact fields, including the provider key, and refuses recipient numbers, native context and unsupported directions. PostgreSQL captures before waits, audits only the public role and refuses malformed stored shapes. Incoming-to-outgoing collisions and changed clinic numbers cannot become duplicate admissions. Pending shared-number location choice remains incoming only.

This is a prerequisite for the actual conversation adapter. Activation, renewal, expiry and local closure reuse the existing session lifecycle; they prove only that lifecycle. The separate permanent outbound session exclusion, contact/call holds, report action and independently approved provider/clinic authority are unchanged. A local ended state does not prove all provider calls or speech closed and cannot release contact holds.

Standalone production voice continues to use a transient rich ledger. The PostgreSQL reference tests explicitly opt into synthetic rich-state mode; ordinary standalone rich-call persistence still refuses admission. No patient-bearing schema or persistent call map is introduced.

## Validation

The original source counterexamples fail on the previous code: a valid outbound admission is rejected while an unsafe mixed outgoing/incoming shape with a private destination is accepted. Legacy incoming admission remains a passing control.

Current source tests cover the separate shape, original lifecycle, recipient/native-context refusal, direction/clinic-number collisions, incoming ingress adoption refusal, pending-location refusal and malformed timing/keys. PostgreSQL tests load the emitted ledger/runtime, exercise cold recovery and public audit payloads, observe a real advisory-lock wait before mutating the caller-owned object, and check corrupt-row refusal. All application tables and an unfiltered PostgreSQL17 backup exclude synthetic recipient/patient canaries. Existing incoming admission and shared-number controls run beside them.

[Execution progress](EXECUTION_PROGRESS.md) records actual work IDs, measured results and remaining cloud qualification. Exact commands:

```sh
npm run typecheck
npm run build:voice-tests
node --test --test-concurrency=2 test/admission/outbound-call-admission.test.ts test/admission/admission.test.ts test/admission/shared-number-intake.test.ts test/admission/pending-location.test.ts
bash scripts/with-postgres.sh bash -c 'npm run db:migrate && ABBY_LEDGER=postgres node --test --test-concurrency=4 test/storage/postgres-outbound-call-admission.test.ts test/admission/admission.test.ts test/admission/shared-number-intake.test.ts test/admission/pending-location.test.ts'
```

Actual outbound conversation with a separately approved greeting and bound effective runtime/profile, immutable complete final provider/contact/speech reporting, independently verified original-patient/exact clinical handoff and approved gap13 remain next. Actual provider/public transport/acoustic/clinic acceptance and activation remain separate. No real provider/clinic traffic, deployment or Karen deletion occurred.
