# Marketing Contact Privacy Status And Gap Register

This document records the implemented marketing/contact privacy controls and the remaining business, legal, and operational decisions. It is a technical source of evidence, not legal advice. Consent wording, retention periods, jurisdiction coverage, and operating procedures still require approval from the accountable business/privacy owner and qualified privacy/legal counsel.

## Current System Boundary

- New contact popup, general inquiry, training/contact, and booking marketing-choice records are written to private PostgreSQL through `src/lib/marketing-contact/marketing-contact-store.ts`.
- Sanity stores public/editorial content. Historical `contactPopupSubmission`, `generalInquiry`, `contactForm`, and `bookingMarketingOptIn` documents may remain as migration sources, but no new live submission or consent record belongs there.
- Contact-popup wording remains editorial configuration in Sanity under `globalSettings.contactPopup`.
- Operational booking UI wording, including `marketingOptInLabel`, is stored in PostgreSQL `booking_business_settings`, loaded by `src/lib/private-db/booking-business-settings-repository.ts`, and managed at `/admin/booking-settings`. The unregistered Sanity `bookingSettings` document and its loader are legacy V1 compatibility only.
- Customer PII, consent evidence, suppression state, campaign state, provider identifiers, transaction history, and payment data must not be written to Sanity.

## Implemented Controls

### Consent And Submission Evidence

The private data model separates current audience state from per-submission and append-only consent evidence:

- `marketing_contacts` contains contacts with affirmative marketing consent and their current subscription state.
- `marketing_contact_submissions` records each supported form or booking marketing choice, including source, path, consent choice, consent-text snapshot, minimized form-specific payload, and optional migration provenance.
- `marketing_consent_events` records `opt_in`, `no_opt_in`, `unsubscribe`, and `backfill_consent` events.
- A negative booking marketing choice creates submission and consent evidence but does not create or update a consolidated marketing contact.
- Backfilled Sanity records retain source document ID, type, timestamps, migration time, and inferred or explicit consent status where available.

The durable evidence fields are implemented in `src/lib/private-db/schema.ts` and populated through `src/lib/marketing-contact/marketing-contact-store.ts`. They include normalized and submitted email, submitted contact fields where applicable, source form/path, consent choice and timestamp, displayed consent text, source-system provenance, and structured payload fields.

### Unsubscribe, Suppression, And Resend Synchronization

Unsubscribe persistence and provider suppression are implemented:

- A verified Resend `contact.updated` webhook with `unsubscribed=true` records the unsubscribe in PostgreSQL through `/api/webhooks/resend`.
- The transaction stamps `marketing_contacts.unsubscribed_at`, appends an `unsubscribe` consent event, and prevents queued or in-flight opt-in sync jobs from re-subscribing the address.
- Internally initiated unsubscribes use `recordInternalUnsubscribe`, which applies the same database suppression and enqueues a durable `unsubscribe_sync` job for Resend.
- Resend-originated events do not enqueue a second provider update, preventing a Resend-to-database-to-Resend loop.
- Marketing audience queries select only rows that were created from affirmative consent and have no `unsubscribed_at` value.

The persistence and durable outbox behavior live in `src/lib/marketing-contact/marketing-contact-store.ts`; provider delivery is handled by `src/lib/marketing-contact/marketing-contact-sync-worker.ts`.

The code contains the internal unsubscribe primitive, but this audit did not find a public self-service unsubscribe endpoint or an admin unsubscribe button. Resend-hosted unsubscribe is the implemented customer path. Add a first-party control only if the approved operating model requires one.

### Admin Audience And Campaign Operations

The private admin surface is implemented at `/admin/marketing`:

- `marketing:view` protects audience, contact, unsubscribe, and delivery-sync views.
- `marketing:send` separately protects the campaign composer and send actions.
- Operators can review current audience counts, unsubscribed contacts, source/date filters, consent evidence, and delivery-sync issues.
- Authorized campaign operators can save a draft, send a test to themselves, send to the current opted-in audience, and review campaign history.
- Campaign actions sanitize message HTML and persist campaign state in PostgreSQL.
- Recipient estimation and provider send logic exclude contacts whose `unsubscribed_at` is set.

Relevant implementation paths are `src/app/admin/(protected)/marketing/page.tsx`, `src/app/admin/(protected)/marketing/campaigns/actions.ts`, and `src/lib/marketing-campaign/**`.

### Retention And Redaction

Retention and redaction operations are implemented in `src/lib/private-db/retention.ts`. An authorized `GET /api/admin/private-data-retention` invocation executes the destructive cleanup and then returns the affected-record summary plus the configured window metadata; it is not an inspection-only endpoint:

- Marketing contact profile fields are redacted after 730 inactive days from `last_consented_at`.
- Unsubscribed marketing contacts are deleted after 2,555 days from `unsubscribed_at`.
- Non-consenting submissions are deleted after 180 days from `submitted_at`.
- Consenting submissions have identity and payload fields redacted after 395 days from `submitted_at`.
- Consent events are deleted after 2,555 days from `occurred_at`; nullable submission references use `ON DELETE SET NULL` so consent evidence can outlive an earlier submission deletion.
- Marketing sync-job payloads are redacted after 395 days, and terminal sync jobs are deleted after 2,555 days.

These are implemented technical defaults, not evidence that the periods have received legal approval or that the scheduled job has run successfully in production. Approval, production execution history, backup retention, and provider-side retention remain operational verification items.

## Remaining Gap Register

### 1. Accountable Ownership And Contractor Transition

The working assumption is that Nataliea is the accountable business/privacy owner and Dardan is a contract technical operator while engaged. This division is not established by code and must be confirmed in an owner-approved operating record.

Required decisions:

- Name the permanent owner for DSARs, unsubscribe escalations, retention-job review, access review, incident response, and legal/counsel coordination.
- Define the handoff when the technical contract ends or changes scope.
- Record which private systems and PII a contractor may access, keep access least-privilege, and revoke or rotate access at offboarding.
- Prohibit production-PII exports to personal devices unless an approved secure handling procedure explicitly permits them.

### 2. Consent Wording And Jurisdiction Review

Business ownership and qualified counsel must approve or revise the consent and privacy wording for:

- general inquiry;
- training/contact;
- contact popup/email list;
- service-booking marketing choice; and
- every campaign footer and unsubscribe presentation.

The review must determine the applicable CASL, PIPEDA, provincial, GDPR, or other jurisdictional requirements. A service inquiry must not be treated as marketing consent unless the form presents explicit consent language and the visitor affirmatively opts in.

### 3. DSAR Intake, Export, Correction, And Deletion

No complete DSAR workflow is established by the current marketing admin surface. Define and test an operator procedure that can:

- verify the requester and search by normalized email;
- export contact, submission, consent, suppression, sync, and campaign-delivery evidence in a readable format;
- correct inaccurate contact details;
- delete or redact records where legally allowed;
- preserve the minimum suppression evidence needed to avoid accidental re-subscription; and
- record request intake, verification, decision, completion date, operator, and notes.

Counsel must confirm response timelines, identity-verification rules, deletion exceptions, and the minimum evidence retained after a request.

### 4. Retention Approval And Production Verification

The accountable owner and counsel must approve or revise every implemented window. If a window changes, update `PRIVATE_DATA_RETENTION_WINDOWS`, tests, and the operator runbook together.

Production operations must also verify:

- the retention job is scheduled and has successful execution history;
- failures are visible to a named operator;
- backup and point-in-time-recovery retention is compatible with the approved policy; and
- Resend and any other processor-side records follow the approved provider-retention procedure.

### 5. Historical Sanity Submission Disposition

After backfill counts and provenance are verified, the accountable owner must decide whether historical Sanity submissions are exported, redacted, hidden, retained temporarily, or deleted. Before mutation:

- identify production PII and legal/audit retention obligations;
- preserve an approved backup when required;
- verify each imported record in PostgreSQL; and
- remove or hide legacy submission document types from editorial workflows so editors do not treat them as active intake stores.

### 6. Lawful Basis And Purpose Register

Record and approve purpose and lawful-basis decisions separately for:

- marketing campaigns;
- transactional email;
- inquiry response;
- training enrollment follow-up;
- booking operational communication;
- suppression-list retention; and
- compliance/audit evidence.

Do not infer that consent for one purpose authorizes another.

### 7. Additional Evidence Collection

Decide whether IP-derived evidence, IP hashes, or user-agent snapshots are necessary and proportionate for consent proof. Do not add them by default. If approved, document minimization, access, retention, and collision/rotation behavior rather than storing raw network identifiers indefinitely.

### 8. Operating Runbook And Incident Response

Create or update the operator runbook for:

- database and admin access review;
- Resend webhook and sync-job failures;
- campaign-send approval and evidence;
- unsubscribe escalation and timing review;
- retention execution and failure handling;
- backup/restore expectations;
- suspected PII exposure; and
- privacy-request handling.

Any production PII exposure or suspected access misconfiguration must trigger the approved incident-notification process.

## Evidence References

- CRTC, [Keeping records of consent](https://www.canada.ca/en/radio-television-telecommunications/news/2016/07/enforcement-advisory-notice-for-businesses-and-individuals-on-how-to-keep-records-of-consent.html)
- CRTC, [CASL guidance](https://crtc.gc.ca/eng/com500/guide.htm)
- Office of the Privacy Commissioner of Canada, [Consent guidance](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle/principles/p_consent/)
- Office of the Privacy Commissioner of Canada, [Limiting use, disclosure, and retention](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle/principles/p_use/)
- Office of the Privacy Commissioner of Canada, [Access guidance](https://www.priv.gc.ca/en/privacy-topics/accessing-personal-information/api_bus/)
- Office of the Privacy Commissioner of Canada, [Privacy management program guidance](https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/pipeda-compliance-help/pipeda-compliance-and-training-tools/gl_acc_201204/)
- European Commission, [Data-protection principles](https://commission.europa.eu/law/law-topic/data-protection/reform/rules-business-and-organisations/principles-gdpr/overview-principles/what-data-can-we-process-and-under-which-conditions_en)
- European Commission, [Individual rights overview](https://commission.europa.eu/law/law-topic/data-protection/reform/rights-citizens/my-rights/what-are-my-rights_en)
- EDPB, [Lawful processing guidance](https://www.edpb.europa.eu/sme-data-protection-guide/process-personal-data-lawfully_en)
