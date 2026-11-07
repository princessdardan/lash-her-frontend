# Learning, authoring and legacy migration brief

Owners: Course for curriculum/quizzes/access/media/imports; FE for admin/learner UI, routes, optional consent and browser progress. Tasks: P2-05–P2-10, P3-01–P3-05, P6-06 and POST-02. Source fields and legacy module/question `_key` values come from the approved Sanity export, not guessed fixtures. Existing launch scope is unchanged.

## Decisions and artifacts before implementation

- Define validated versioned Portable Text/quiz/media documents, stable IDs and optimistic concurrency/reordering rules. Publication requires valid CAD/access mode, complete content/quizzes and ready media. Preserve progress/audit references through archival/replacement.
- Retain practice-mode completion for imports and configurable 80% graded default/unlimited retries for new graded quizzes. Separate resume from maximum watched position; delayed heartbeats cannot overwrite newer state. Generic progress/imports cannot satisfy graded assessments.
- Record the business-facing consequences of archive denial for existing purchases, history/community, support/refunds and restoration before paid publication. Do not silently change the existing archive access rule.
- Produce durable source-key → Course UUID/media mappings, per-field mapping/version rules, count/content hashes and repeatable dry-run/import receipts. Include introductions, rich text, feedback, captions/transcripts, covers/SEO and video ownership.
- Identify which public assets remain public, which are safely reused/imported into Course-managed Mux, and how signed playback/replacement/reordered webhooks and recovery are verified. App switching alone does not retire public URLs.

## Acceptance

Test conflicting edits/reorders, publication/archive transitions, quiz revisions and immutable attempts, stale progress, cross-learner access and signed-token renewal/revocation windows. Exercise actual author-to-learner behavior with loading/pending/revoked/processing/unavailable states, mobile/keyboard/captions/transcripts and current design tokens.

Repeat import/dry run without duplicate identities or unintended edits; reconcile complete selected counts/hashes/mappings. Validate signed-in browser progress against mappings and bounds; missing cookies permit free re-enrollment. Browser state never establishes identity/enrollment or graded completion. Preserve canonical course URLs, links/SEO and historical consent without creating new subscription changes.

P3-05 rehearses freeze/final sync/read-authoring switch and compatible rollback. P6-06 records actual production cutover and the minimum 90-day transition due date. POST-02 checks elapsed time, acceptance, exports/mappings and dependencies before removing obsolete paths or public media. Calendar dates are not invented during planning; unsafe cleanup remains blocked while compatibility stays available.
