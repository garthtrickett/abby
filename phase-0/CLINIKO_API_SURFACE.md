# Cliniko documented API inventory

**Snapshot:** 2026-09-28; Cliniko OpenAPI v1; 45 resource groups, 143 unique paths, 223 operations.

**Source:** [Cliniko API reference](https://docs.api.cliniko.com/openapi) and its [OpenAPI JSON](https://docs.api.cliniko.com/_bundle/openapi.json?download=). Download SHA-256: `81a12a8a36547ecf9c421b2f1a56fcf13cb34e08758161ff19bbb2253599fea3`.

This is an inventory of the **published** operations, not a claim that the demo API key can call them, that their fields are mapped, or that a mutation is safe for Abby to automate. The [Cliniko evidence register](CLINIKO_EVIDENCE.md) records observed behavior; the [support matrix](SUPPORT_MATRIX.md) decides receptionist capability modes. A future refresh should compare the source hash and regenerate this table from `paths` and operation `tags` in the official OpenAPI JSON.

## Abby coverage and immediate gaps

| Receptionist concern | Published operations involved | Current Abby evidence | Next integration proof |
| --- | --- | --- | --- |
| Clinic, service, and practitioner metadata | `GET /businesses`, `GET /appointment_types`, `GET /practitioners`, `GET /businesses/{business_id}/practitioners`, `GET /practitioners/{practitioner_id}/appointment_types` | Demo list reads succeeded (C-LIVE-01). Current availability adapter checks configured resource relationships in the demo profile (C-LIVE-10), fake-provider contracts, and synthetic voice tests; no general metadata-to-policy adapter | Bind scope, settings, eligibility, and current permissions to one call policy |
| Patient discovery and verification | `GET /patients`, `GET /patients/{id}` | Exact email/date-of-birth candidate adapter observed for synthetic results (C-LIVE-08/09). A local phone index pages patient records, stores only phone-to-ID links, and rechecks candidates by ID. A synthetic connected voice call can query it after clinic binding; no real transport or dialogue-level verification is wired. | Prove complete sync and clinic-approved caller verification and disclosure policy |
| Available times | `GET /businesses/{business_id}/practitioners/{practitioner_id}/appointment_types/{appointment_type_id}/available_times` | Read adapter and demo probe succeeded (C-LIVE-05); results explicitly non-reservable | Approve policy and wording; prove live caller path; revalidate any future offer at commit |
| Existing appointments | `GET /individual_appointments` | Read adapter and one synthetic live record succeeded behind host-issued proof (C-LIVE-06) | Approve real verification, disclosure, and live caller path |
| Appointment writes | `POST /individual_appointments`, `PATCH /individual_appointments/{id}`, `PATCH /individual_appointments/{id}/cancel` | Synthetic create/move/cancel probe succeeded (C-LIVE-04); two concurrent same-slot creates both succeeded (C-LIVE-07); no write adapter | Safe exclusivity or clinic-approved conflict route, exact lost-response reconciliation, current authorization; until then request-only |
| Staff tasks and notifications | `POST /communications`, `POST /recalls`, and their reads | Communication create only records a patient-linked memo, even for SMS/email (C-DOC-07). Cliniko documents a manual Recalls report and recalled marker (C-DOC-09). The demo account accepted a synthetic recall, returned one exact patient-scoped marker match, marked it recalled, and archived it (C-LIVE-11). A read-only TypeScript lookup now checks exact UUID marker and patient link with bounded pagination in synthetic tests (C-LOCAL-12). Neither the API contract nor that probe proves task assignment, delivery, or safe lost-response retry. Standalone patient-specific work must reside in Cliniko (D-11). | Verify a clinic-approved Cliniko task workflow, staff visibility/acknowledgment, exact-key reconciliation, and non-patient independent failure escalation (D-07). Until proven, patient-specific `requestOnly` and task handoff are unavailable. |

The published `GET /patients` filters are accepted privacy policy, archive/create/update timestamps, date of birth, email, first name, ID, last name, old reference ID, and preferred first name. **Phone number is not a documented patient-list filter**, even though patient records include phone numbers. Abby therefore builds a local clinic-scoped phone-to-ID index outside the call path and re-reads candidates by ID. Caller ID is only a lookup clue, not verification. See the [Patient API reference](https://docs.api.cliniko.com/openapi/patient) and the [phone-index boundary](PHONE_INDEX_AND_PRIVACY_GATE.md).

## Complete published operation list

Each operation appears once under its OpenAPI tag. Deprecated operations are identified as such. This table inventories methods and paths only; request/response fields, pagination, errors, permission behavior, and runtime semantics still require operation-specific mapping before use.

| Resource group | Operations |
| --- | --- |
| Appointment Type | `GET /appointment_types`<br>`POST /appointment_types`<br>`GET /appointment_types/{id}`<br>`PATCH /appointment_types/{id}`<br>`DELETE /appointment_types/{id}` (deprecated)<br>`POST /appointment_types/{id}/archive`<br>`GET /practitioners/{practitioner_id}/appointment_types` |
| Appointment Type Billable Item | `GET /appointment_type_billable_items`<br>`POST /appointment_type_billable_items`<br>`GET /appointment_type_billable_items/{id}`<br>`PATCH /appointment_type_billable_items/{id}`<br>`DELETE /appointment_type_billable_items/{id}` |
| Appointment Type Product | `GET /appointment_type_products`<br>`POST /appointment_type_products`<br>`GET /appointment_type_products/{id}`<br>`PATCH /appointment_type_products/{id}`<br>`DELETE /appointment_type_products/{id}` |
| Attendee | `GET /attendees`<br>`POST /attendees`<br>`GET /attendees/{id}`<br>`PATCH /attendees/{id}`<br>`DELETE /attendees/{id}` (deprecated)<br>`POST /attendees/{id}/archive`<br>`PATCH /attendees/{id}/cancel`<br>`GET /group_appointments/{group_appointment_id}/attendees` (deprecated)<br>`GET /individual_appointments/{individual_appointment_id}/attendees` (deprecated)<br>`GET /patient_cases/{patient_case_id}/attendees` (deprecated) |
| Availability Block | `GET /availability_blocks`<br>`POST /availability_blocks`<br>`GET /availability_blocks/{id}` |
| Available Time | `GET /businesses/{business_id}/practitioners/{practitioner_id}/appointment_types/{appointment_type_id}/available_times`<br>`GET /businesses/{business_id}/practitioners/{practitioner_id}/appointment_types/{appointment_type_id}/next_available_time` |
| Billable Item | `GET /billable_items`<br>`POST /billable_items`<br>`GET /billable_items/{id}`<br>`PATCH /billable_items/{id}`<br>`DELETE /billable_items/{id}` (deprecated)<br>`POST /billable_items/{id}/archive` |
| Body Chart | `GET /body_charts`<br>`GET /body_charts/{id}` |
| Booking | `GET /bookings`<br>`GET /bookings/{id}`<br>`GET /patient_cases/{patient_case_id}/bookings` (deprecated) |
| Business | `GET /businesses`<br>`POST /businesses`<br>`GET /businesses/{id}`<br>`PATCH /businesses/{id}`<br>`DELETE /businesses/{id}` (deprecated)<br>`POST /businesses/{id}/archive`<br>`POST /businesses/{id}/unarchive` |
| Communication | `GET /communications`<br>`POST /communications`<br>`GET /communications/{id}`<br>`PATCH /communications/{id}`<br>`POST /communications/{id}/archive` |
| Concession Price | `GET /concession_prices`<br>`POST /concession_prices`<br>`GET /concession_prices/{id}`<br>`PATCH /concession_prices/{id}` |
| Concession Type | `GET /concession_types`<br>`POST /concession_types`<br>`GET /concession_types/{id}`<br>`PATCH /concession_types/{id}` |
| Contact | `GET /contacts`<br>`POST /contacts`<br>`GET /contacts/{id}`<br>`PATCH /contacts/{id}`<br>`DELETE /contacts/{id}` (deprecated)<br>`POST /contacts/{id}/archive` |
| Daily Availability | `GET /daily_availabilities`<br>`GET /daily_availabilities/{id}`<br>`GET /businesses/{business_id}/daily_availabilities`<br>`GET /practitioners/{practitioner_id}/daily_availabilities` |
| Group Appointment | `GET /group_appointments`<br>`POST /group_appointments`<br>`GET /group_appointments/{id}`<br>`PATCH /group_appointments/{id}`<br>`DELETE /group_appointments/{id}` (deprecated)<br>`POST /group_appointments/{id}/archive`<br>`GET /group_appointments/{id}/conflicts` |
| Individual Appointment | `GET /individual_appointments`<br>`POST /individual_appointments`<br>`GET /individual_appointments/{id}`<br>`PATCH /individual_appointments/{id}`<br>`DELETE /individual_appointments/{id}` (deprecated)<br>`POST /individual_appointments/{id}/archive`<br>`PATCH /individual_appointments/{id}/cancel`<br>`GET /individual_appointments/{id}/conflicts` |
| Invoice | `GET /invoices`<br>`GET /invoices/{id}`<br>`GET /appointments/{appointment_id}/invoices`<br>`GET /attendees/{attendee_id}/invoices` (deprecated)<br>`GET /patient_cases/{patient_case_id}/invoices`<br>`GET /patients/{patient_id}/invoices` (deprecated)<br>`GET /practitioners/{practitioner_id}/invoices` (deprecated) |
| Invoice Item | `GET /invoice_items`<br>`GET /invoice_items/{id}`<br>`GET /invoices/{invoice_id}/invoice_items` (deprecated) |
| Medical Alert | `GET /medical_alerts`<br>`POST /medical_alerts`<br>`GET /medical_alerts/{id}`<br>`PATCH /medical_alerts/{id}`<br>`DELETE /medical_alerts/{id}`<br>`GET /patients/{patient_id}/medical_alerts` (deprecated) |
| Patient | `GET /patients`<br>`POST /patients`<br>`GET /patients/{id}`<br>`PATCH /patients/{id}`<br>`DELETE /patients/{id}` (deprecated)<br>`POST /patients/{id}/archive`<br>`POST /patients/{id}/unarchive` |
| Patient Attachment | `GET /patient_attachments`<br>`POST /patient_attachments`<br>`GET /patient_attachments/{id}`<br>`PATCH /patient_attachments/{id}`<br>`DELETE /patient_attachments/{id}` (deprecated)<br>`POST /patient_attachments/{id}/archive`<br>`GET /patient_cases/{patient_case_id}/patient_attachments`<br>`GET /patients/{patient_id}/attachment_presigned_post`<br>`GET /patients/{patient_id}/patient_attachments` (deprecated) |
| Patient Case | `GET /patient_cases`<br>`POST /patient_cases`<br>`GET /patient_cases/active`<br>`GET /patient_cases/{id}`<br>`PATCH /patient_cases/{id}`<br>`POST /patient_cases/{id}/archive` |
| Patient Form | `GET /patient_forms`<br>`POST /patient_forms`<br>`GET /patient_forms/{id}`<br>`PATCH /patient_forms/{id}`<br>`GET /attendees/{attendee_id}/patient_forms` (deprecated)<br>`POST /patient_forms/{id}/archive` |
| Patient Form Template | `GET /patient_form_templates`<br>`POST /patient_form_templates`<br>`GET /patient_form_templates/{id}`<br>`PATCH /patient_form_templates/{id}`<br>`POST /patient_form_templates/{id}/archive` |
| Practitioner | `GET /practitioners`<br>`GET /practitioners/inactive`<br>`GET /practitioners/{id}`<br>`GET /appointment_types/{appointment_type_id}/practitioners`<br>`GET /businesses/{business_id}/practitioners`<br>`GET /appointment_types/{appointment_type_id}/practitioners/inactive`<br>`GET /businesses/{business_id}/practitioners/inactive` |
| Practitioner Reference Number | `GET /practitioner_reference_numbers`<br>`POST /practitioner_reference_numbers`<br>`GET /practitioner_reference_numbers/{id}`<br>`PATCH /practitioner_reference_numbers/{id}`<br>`DELETE /practitioner_reference_numbers/{id}`<br>`GET /practitioners/{practitioner_id}/practitioner_reference_numbers` (deprecated) |
| Product | `GET /products`<br>`POST /products`<br>`GET /products/{id}`<br>`PATCH /products/{id}`<br>`DELETE /products/{id}` (deprecated)<br>`POST /products/{id}/archive` |
| Product Supplier | `GET /product_suppliers`<br>`POST /product_suppliers`<br>`GET /product_suppliers/{id}`<br>`PATCH /product_suppliers/{id}`<br>`DELETE /product_suppliers/{id}` |
| Public Settings | `GET /settings/public` |
| Recall | `GET /recalls`<br>`POST /recalls`<br>`GET /recalls/{id}`<br>`PATCH /recalls/{id}`<br>`POST /recalls/{id}/archive` |
| Recall Type | `GET /recall_types`<br>`POST /recall_types`<br>`GET /recall_types/{id}`<br>`PATCH /recall_types/{id}`<br>`POST /recall_types/{id}/archive` |
| Referral Source | `GET /referral_sources`<br>`GET /patients/{patient_id}/referral_source`<br>`PATCH /patients/{patient_id}/referral_source` |
| Referral Source Type | `GET /referral_source_types`<br>`GET /referral_source_types/{id}` |
| Relationship | `GET /relationships`<br>`POST /relationships`<br>`GET /relationships/{id}`<br>`PATCH /relationships/{id}`<br>`POST /relationships/{id}/archive` |
| Service | `GET /services`<br>`GET /businesses/{business_id}/services` |
| Settings | `GET /settings` |
| Signature | `GET /patient_forms/{patient_form_id}/signatures/{id}` |
| Stock Adjustment | `GET /stock_adjustments`<br>`POST /stock_adjustments`<br>`GET /stock_adjustments/{id}` |
| Tax | `GET /taxes`<br>`POST /taxes`<br>`GET /taxes/{id}`<br>`PATCH /taxes/{id}`<br>`DELETE /taxes/{id}` |
| Treatment Note | `GET /treatment_notes`<br>`POST /treatment_notes`<br>`GET /treatment_notes/{id}`<br>`PATCH /treatment_notes/{id}`<br>`DELETE /treatment_notes/{id}` (deprecated)<br>`GET /patients/{patient_id}/treatment_notes`<br>`POST /treatment_notes/{id}/archive`<br>`POST /treatment_notes/{id}/unarchive` |
| Treatment Note Template | `GET /treatment_note_templates`<br>`POST /treatment_note_templates`<br>`GET /treatment_note_templates/{id}`<br>`PATCH /treatment_note_templates/{id}`<br>`DELETE /treatment_note_templates/{id}` (deprecated)<br>`POST /treatment_note_templates/{id}/archive` |
| Unavailable Block | `GET /unavailable_blocks`<br>`POST /unavailable_blocks`<br>`GET /unavailable_blocks/{id}`<br>`PATCH /unavailable_blocks/{id}`<br>`DELETE /unavailable_blocks/{id}` (deprecated)<br>`POST /unavailable_blocks/{id}/archive`<br>`GET /unavailable_blocks/{id}/conflicts` |
| Unavailable Block Type | `GET /unavailable_block_types`<br>`POST /unavailable_block_types`<br>`GET /unavailable_block_types/{id}`<br>`PATCH /unavailable_block_types/{id}`<br>`POST /unavailable_block_types/{id}/archive` |
| User | `GET /user`<br>`GET /users`<br>`GET /users/{id}` |

**Inventory check:** 45 groups; 223 operations; 143 unique paths.
