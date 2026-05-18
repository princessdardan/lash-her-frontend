# Marketing Contact Privacy Compliance Hardening Plan

> **For agentic workers:** This plan is technical planning support, not legal advice. Do not invent retention periods, consent wording, lawful-basis decisions, or compliance owner decisions. Use checkbox (`- [ ]`) tasks for tracking.

**Goal:** Harden the private database marketing/contact workstream so form submissions, booking marketing choices, consent events, and legacy Sanity backfill records have privacy-safe evidence, verification, and operating checkpoints before launch.

**Architecture:** Treat Sanity as the public/editorial CMS and historical submission backfill source only. New general inquiry, training contact, contact popup, booking marketing choice, consent, unsubscribe, and suppression records belong in the private PostgreSQL database before any follow-up email or marketing workflow uses them.

**Tech Stack:** Next.js server actions, booking service, private Neon/Postgres via Drizzle, Resend, Sanity Content Lake as legacy backfill source, and operator runbooks.

---

## Scope and Non-Goals

- This plan covers technical readiness, evidence capture, and operational checkpoints for marketing/contact privacy compliance.
- Final consent wording, retention windows, lawful-basis decisions, jurisdiction coverage, and operating ownership require business and qualified privacy/legal review.
- Do not expose secrets, full `DATABASE_URL` values, customer PII, raw form payloads, payment tokens, or raw webhook bodies in tickets, docs, logs, or release evidence.
- Do not add dashboards or admin UI. Any access tooling must wait for access control, audit logging, and approved retention policy.
- Do not run migrations, backfill scripts, or backfill dry-runs as part of this documentation plan.

## Source of Truth

- Compliance context: `docs/marketing-contact-privacy-compliance-follow-up.md`.
- Migration procedure: `docs/private-database-migration-runbook.md`.
- Shared private storage guide: `docs/private-checkout-storage-setup.md`.
- Launch gates: `docs/launch-readiness-checklist.md`.

## Current Technical Facts to Preserve

- General inquiry, training contact, and contact popup submissions write to private DB-backed marketing/contact tables before email.
- Booking records both opted-in and not-opted-in marketing choices in the private DB consent/submission ledger after calendar creation.
- `marketing_contacts` is the lean consented audience table.
- `marketing_contact_submissions` preserves form-specific audit/provenance.
- `marketing_consent_events` preserves consent, no-consent, unsubscribe/withdrawal, and backfill events.
- Sanity submission document types (`generalInquiry`, `contactForm`, `contactPopupSubmission`, `bookingMarketingOptIn`) are legacy/backfill source records unless a documented retention decision says otherwise.

## Approved Operating Model

- Nataliea is accountable for business/privacy decisions and ongoing operations.
- Dardan is the contract technical operator/steward during active engagement, not the permanent DSAR, retention, unsubscribe, or compliance owner.
- Dardan implements technical controls under Nataliea-approved requirements and should not make legal/compliance decisions on Nataliea's behalf.
- Qualified privacy/legal counsel should review consent wording, lawful basis, retention periods, deletion exceptions, and jurisdiction coverage.
- Before launch, Nataliea must name the post-contract owner or vendor for DSARs, unsubscribe checks, access reviews, retention jobs, and incident response.
- Contractor access must be scoped, least-privilege, and revoked or rotated when the contract ends or the scope changes.

## Task 1: Consent Evidence Inventory

**Files:**
- `src/lib/marketing-contact/marketing-contact-store.ts`
- `src/lib/private-db/schema.ts`
- `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Confirm per-flow consent evidence fields**

Expected:
- Evidence plan covers submitted email, normalized email, source form/path, consent timestamp, exact displayed consent or CTA text, privacy link snapshot when available, and source system/document ID for backfill.
- General inquiry, training contact, contact popup, booking opted-in, and booking not-opted-in paths are all listed.
- Nataliea or counsel-approved consent wording/source text is recorded before treating evidence as launch-ready.

- [ ] **Step 2: Confirm negative-choice audit evidence**

Expected:
- Not-opted-in booking marketing choices produce audit evidence without creating or updating consolidated marketing-contact rows.
- No-consent events are included in release evidence with PII redacted.

## Task 2: Unsubscribe and Suppression Workflow Plan

**Files:**
- Future unsubscribe/suppression implementation files after approval
- `docs/launch-readiness-checklist.md`
- `docs/marketing-contact-privacy-compliance-follow-up.md`

- [ ] **Step 1: Define technical suppression behavior**

Expected:
- Bulk marketing send workflows remain blocked until unsubscribe/suppression exists.
- Withdrawal events are recorded in the consent ledger.
- Future marketing sends suppress withdrawn contacts.
- CASL 10-business-day handling is recorded as a planning checkpoint, not as a coded legal conclusion.

- [ ] **Step 2: Define evidence for suppression tests**

Expected:
- Test evidence can prove unsubscribe intake, consent ledger event creation, suppression state, and send suppression without exposing recipient PII.

## Task 3: Retention and Redaction Decision Path

**Files:**
- `docs/private-checkout-storage-setup.md`
- `docs/launch-readiness-checklist.md`
- Future redaction/retention job files only after business/legal decisions exist

- [ ] **Step 1: Record owner/counsel decision checkpoints**

Expected:
- Decision record asks for owner/counsel approval by record type: marketing contacts, contact submissions, consent events, suppression records, checkout orders, payment events, and Sanity backfill records.
- No retention durations are invented.

- [ ] **Step 2: Define redaction behavior after approval**

Expected:
- Future jobs redact only approved fields and log redaction events without raw PII.
- Stop if record-type retention rules are unknown.

## Task 4: DSAR, Access, Correction, and Deletion Workflow Plan

**Files:**
- Future operator workflow/runbook after owner approval
- `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Define search/export/correction/deletion workflow**

Expected:
- Workflow searches by normalized email.
- Export includes contact, submission, consent, suppression, and relevant backfill provenance records in a readable format.
- Correction, deletion, and redaction steps preserve minimal suppression evidence where required to prevent accidental re-subscription.
- Nataliea is accountable for DSAR response decisions; Dardan or another named technical operator only executes approved technical steps.

- [ ] **Step 2: Define DSAR audit trail**

Expected:
- DSAR export, correction, deletion/redaction, intake timestamp, completion timestamp, and operator notes have audit events with PII-safe evidence.

## Task 5: Purpose and Lawful-Basis Tracking Checkpoints

**Files:**
- `docs/marketing-contact-privacy-compliance-follow-up.md`
- Future schema/application files only after decisions are approved

- [ ] **Step 1: Separate communication purposes**

Expected:
- Planning distinguishes marketing emails, transactional emails, inquiry response, training follow-up, booking operational communication, suppression retention, and compliance audit evidence.
- Service inquiry response is not treated as marketing consent unless explicit consent is captured.

- [ ] **Step 2: Record legal decision blockers**

Expected:
- Launch plans identify which lawful-basis and purpose decisions are pending owner/counsel review.
- Implementation stops before coding unsupported legal assumptions.

## Task 6: Security and Logging Safeguards

**Files:**
- `docs/private-checkout-storage-setup.md`
- `docs/launch-readiness-checklist.md`
- `docs/private-database-migration-runbook.md`

- [ ] **Step 1: Confirm private DB safeguards**

Expected:
- Server-only DB credentials, separate staging/production DBs, TLS, least privilege, backups/PITR, and no browser-exposed private variables are launch gates.
- Contractor access scope, approved systems, and access revocation/rotation steps are documented.

- [ ] **Step 2: Confirm PII-safe logging**

Expected:
- Form payloads, raw PII, payment tokens, full connection strings, and raw webhook bodies are excluded from evidence and logs.
- Release evidence uses redacted query output or aggregate counts.

## Task 7: Backfill Evidence and Stop Conditions

**Files:**
- `scripts/backfill-marketing-contact-submissions.ts`
- `docs/private-database-migration-runbook.md`
- `docs/launch-readiness-checklist.md`

- [ ] **Step 1: Define backfill evidence requirements**

Expected:
- Dry-run evidence, execute evidence, imported count by source type, skipped count, provenance fields, and repeated-run duplicate prevention are defined before running backfill.
- Evidence never includes raw form payloads or PII.

- [ ] **Step 2: Define backfill stop conditions**

Expected:
- Stop if target DB identity is uncertain, source Sanity dataset is wrong, source counts are unexpected, private tables are missing, duplicate protection fails, or Sanity source retention/redaction decision is absent.

## Final Verification

- [ ] `rg -n "write to Sanity|Sanity write|SANITY_FORM_TOKEN|private checkout|checkout-only|formClient" docs README.md AGENTS.md src/app/AGENTS.md` has no stale live-form guidance unless explicitly marked historical/legacy/conditional.
- [ ] Docs state new form/marketing writes are private DB-backed.
- [ ] Docs state Sanity submission document types are legacy/backfill source records only.
- [ ] Docs include consent evidence, no-opt-in audit, unsubscribe/suppression, retention/redaction, DSAR, purpose tracking, security, and audit-trail gates.
- [ ] No migrations, backfills, dry-runs, emails, or external side-effect commands were run for this docs update.

## Stop Conditions

- Stop if a proposed change requires legal consent wording, retention periods, lawful-basis decisions, or compliance owner assignment.
- Stop if a verification step would expose secrets, customer PII, raw form payloads, payment tokens, or raw webhook bodies.
- Stop if someone asks to add dashboards/admin UI before access control, audit logging, and retention policy are approved.
- Stop if a migration/backfill command would be required; move that work to the migration runbook and request explicit approval.
- Stop if no post-contract owner or vendor is named for ongoing DSAR, unsubscribe, retention, access review, and incident-response operations.

## Suggested Commit Sequence

1. `docs: plan marketing privacy compliance hardening`
2. `docs: clarify private pii storage runbooks`
3. `docs: update form storage launch gates`
