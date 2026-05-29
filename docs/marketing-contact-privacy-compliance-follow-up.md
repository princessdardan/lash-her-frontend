# Marketing Contact Privacy Compliance Follow-up

This document captures the compliance workstream that should follow the marketing-contact storage migration. It is technical planning support, not legal advice. Final consent wording, retention periods, jurisdiction coverage, and operating procedures should be reviewed by business ownership and qualified privacy/legal counsel.

## Scope Boundary

Marketing/contact submissions now belong in the private Neon/Postgres database, while Sanity remains public/editorial content plus historical submission backfill source only. The private database must preserve the consent evidence needed for compliance review and operations.

Full CASL, PIPEDA, GDPR, and related privacy compliance is broader than the storage migration. It requires unsubscribe handling, consent wording approval, retention schedules, data subject request workflows, access controls, operational logging, incident response, and periodic review.

## Approved Operating Model

Nataliea is the accountable business/privacy owner for the Lash Her records. Dardan is the contract technical operator/steward while actively engaged on the project, responsible for implementation and technical evidence under Nataliea-approved requirements, not for permanent compliance ownership.

Recommended role split:

- Nataliea approves consent wording, retention/redaction decisions, unsubscribe/suppression policy, DSAR responses, and any decision to export, delete, redact, hide, or retain records.
- Dardan implements storage, exports, redaction tooling, suppression logic, evidence capture, and secure configuration under Nataliea's written direction during the contract.
- Qualified privacy/legal counsel should be consulted for consent wording, lawful-basis decisions, retention periods, deletion exceptions, and jurisdiction coverage.
- Nataliea or a named vendor must own ongoing DSAR, unsubscribe, access review, retention job, and incident-response operations after Dardan's contract ends.

Contractor safeguards:

- Keep Dardan's access least-privilege and limited to active work.
- Record what private systems and PII Dardan may access.
- Revoke or rotate contractor access when the contract ends or scope changes.
- Do not export production PII to personal devices unless Nataliea explicitly approves a secure handling procedure.
- Treat any PII exposure or suspected misconfiguration found during technical work as an incident-notification trigger to Nataliea.

## Legacy Storage Facts

- Public/editorial content is stored in Sanity.
- Historical contact popup submissions may exist in Sanity as `contactPopupSubmission` and are a backfill source only.
- Historical general inquiries may exist in Sanity as `generalInquiry` and are a backfill source only.
- Historical training/contact submissions may exist in Sanity as `contactForm` and are a backfill source only.
- Historical booking marketing opt-ins may exist in Sanity as `bookingMarketingOptIn` and are a backfill source only.
- New contact popup, general inquiry, training/contact, and booking marketing choice records should write to the private Neon/Postgres database.
- Private DB tables include checkout orders, payment events, training enrollments, marketing contacts, marketing/contact submissions, and consent events.
- Checkout/order storage policy in `README.md` states that transaction history, customer PII, and payment tokens must not be stored in Sanity.
- Contact popup settings are loaded from Sanity `globalSettings.contactPopup` and include `privacyText`, `privacyLinkLabel`, and `privacyLinkHref`.
- Booking settings are loaded from Sanity `bookingSettings` and include `marketingOptInLabel`.

## Private DB Storage Facts

The marketing-contact storage migration establishes these private DB record categories:

- A submission/audit table for every general inquiry, training/contact form, contact popup/email-list signup, and booking marketing choice.
- A consolidated marketing-contact table that includes only contacts with affirmative marketing consent.
- A consent event ledger for opt-ins, opt-outs, no-consent choices, and imported historical records where consent status is known or inferred.
- Backfilled Sanity submission records with provenance fields such as Sanity `_id`, `_type`, `_createdAt`, migration timestamp, and inferred consent status.

Negative booking opt-in choices should be audited, but must not create or update consolidated marketing-contact rows.

## Compliance Measures To Implement

### Consent Evidence

Store enough evidence to prove consent and explain how it was obtained:

- normalized email and submitted email
- contact name, phone, Instagram, and location only where submitted
- source form and source path
- consent boolean and consent timestamp
- displayed consent text or CTA text snapshot
- privacy link label and href snapshot
- consent text/version identifier when available
- source system and source record ID for backfilled records
- minimized, structured form-specific fields rather than raw submission payload snapshots unless privacy/legal approval explicitly requires otherwise

CASL places the burden of proving consent on the sender, so consent records should be durable and queryable.

Reference: CRTC, “Keeping records of consent”  
https://www.canada.ca/en/radio-television-telecommunications/news/2016/07/enforcement-advisory-notice-for-businesses-and-individuals-on-how-to-keep-records-of-consent.html

### Unsubscribe And Withdrawal

Implement a suppression workflow before sending marketing campaigns from this database:

- Add an unsubscribe endpoint or admin workflow.
- Record unsubscribe/withdrawal events in the consent ledger.
- Mark the consolidated contact as unsubscribed or suppressed.
- Stop marketing sends immediately after suppression.
- Record CASL 10-business-day handling as a planning checkpoint for business/privacy/legal confirmation.

References:  
CRTC CASL guidance: https://crtc.gc.ca/eng/com500/guide.htm  
OPC consent guidance: https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle/principles/p_consent/

### Data Minimization

Keep the consolidated marketing-contact table lean. It should be a marketing audience table, not a complete operational history.

Recommended split:

- Consolidated contact table: current marketing status and latest useful contact fields.
- Submission table: per-form audit record.
- Consent events table: append-only consent, no-consent, unsubscribe, and backfill events.

Do not store raw payment tokens, card data, full payment payloads, or customer order PII in Sanity.

References:  
European Commission GDPR principles: https://commission.europa.eu/law/law-topic/data-protection/reform/rules-business-and-organisations/principles-gdpr/overview-principles/what-data-can-we-process-and-under-which-conditions_en  
OPC PIPEDA principles: https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle

### Retention And Redaction

Retention windows are now implemented in `src/lib/private-db/retention.ts` and surfaced as static metadata by `/api/admin/private-data-retention`. The current marketing/contact windows are:

- Marketing contacts: redact inactive profile fields after 730 days from `last_consented_at`; delete unsubscribed contacts after 2555 days from `unsubscribed_at`.
- Consent events: delete after 2555 days from `occurred_at`; submission references are nullable with `ON DELETE SET NULL` so consent evidence survives earlier submission deletion.
- Non-consenting submissions: delete after 180 days from `submitted_at`.
- Consenting submissions: redact identity and payload fields after 395 days from `submitted_at`.
- Backfilled Sanity submissions: migrate, verify, then decide whether Sanity copies are exported, redacted, hidden, or deleted.

These periods are technical defaults and must still be approved or revised by the accountable business/privacy owner and qualified privacy/legal counsel. If approved periods change, update `PRIVATE_DATA_RETENTION_WINDOWS`, tests, and operational runbooks before relying on the scheduled job.

References:  
OPC limiting use, disclosure, and retention: https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle/principles/p_use/  
OPC retention best practices: https://www.priv.gc.ca/en/privacy-topics/business-privacy/breaches-and-safeguards/safeguarding-personal-information/gd_rd_201406/

### Access, Export, Correction, And Deletion Requests

Create an operational DSAR workflow before using the database as a long-term marketing system:

- Search records by normalized email.
- Export contact, submission, consent, and suppression records in a readable format.
- Correct inaccurate contact details.
- Delete or redact records where legally allowed.
- Preserve minimal suppression evidence where deletion would otherwise allow accidental re-subscription.
- Track request intake, completion date, and operator notes.

Reference timelines to confirm with counsel:

- PIPEDA access responses are generally expected within 30 days.
- GDPR access responses are generally expected within 1 month.

References:  
OPC access guidance: https://www.priv.gc.ca/en/privacy-topics/accessing-personal-information/api_bus/  
European Commission rights overview: https://commission.europa.eu/law/law-topic/data-protection/reform/rights-citizens/my-rights/what-are-my-rights_en

### Lawful Basis And Purpose Tracking

Record lawful basis and purpose separately for each use:

- marketing emails
- transactional emails
- inquiry response
- training enrollment follow-up
- booking operational communication
- suppression list retention
- compliance audit evidence

Do not treat a service inquiry as marketing consent unless the form has explicit consent language and the visitor opts in.

Reference: EDPB lawful processing guidance  
https://www.edpb.europa.eu/sme-data-protection-guide/process-personal-data-lawfully_en

### Security Safeguards

The private database should be treated as sensitive PII infrastructure:

- Keep database credentials server-only.
- Use separate staging and production database branches/connection strings.
- Enforce TLS connections.
- Restrict production database access to the smallest necessary group.
- Avoid logging submitted form payloads or raw PII in app logs.
- Ensure backups and point-in-time recovery settings are understood.
- Document incident response steps for suspected exposure.

References:  
OPC safeguarding personal information: https://www.priv.gc.ca/en/privacy-topics/business-privacy/safeguards-and-breaches/safeguarding-personal-information  
OPC accountability principle: https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/p_principle/principles/p_accountability/

### Audit Trail And Accountability

Log privacy-relevant operational events:

- consent granted
- no-consent booking choice submitted
- unsubscribe or withdrawal
- manual correction
- DSAR export
- deletion/redaction
- retention job execution
- backfill import execution
- admin access to private contact records if an admin UI is later built

Reference: OPC privacy management program guidance  
https://www.priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/pipeda-compliance-help/pipeda-compliance-and-training-tools/gl_acc_201204/

## Implementation Follow-up Checklist

- Approve consent language for general inquiry, training/contact, popup/email-list, and booking forms.
- Add unsubscribe/suppression implementation before any bulk marketing send workflow.
- Approve or revise the implemented retention periods for consented contacts, unsubscribed contacts, non-consenting submissions, consenting submissions, consent events, and Sanity backfill records.
- Define DSAR export/delete/correction owner and procedure.
- Decide whether to store IP hash and user agent for consent evidence; avoid collecting them unless counsel/business confirms necessity.
- Confirm whether existing Sanity submission records contain production PII and export before deletion/redaction.
- Remove or hide Sanity submission document types after backfill verification.
- Add operator runbook notes for database access, backups, incident response, and privacy request handling.
