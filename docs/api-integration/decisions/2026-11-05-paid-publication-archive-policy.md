# Paid publication and archive consequences

Status: approved by Dardan on November 5, 2026 through the explicit policy question in this goal. Applies to P2-05/P2-09 paid catalog/publication and existing access rules. It adds no paid checkout, live publication, production activation or new legal retention/refund period.

The [learning brief](../briefs/learning-and-migration.md) requires the business consequences of archive denial for existing purchases, history/Community, support/refunds and restoration to be recorded before paid publication. Current Course publication rejects every paid course with `PAID_PUBLICATION_POLICY_PENDING`; a checkout exclusion alone does not complete paid catalog/publication.

## Approved policy

1. Preserve the existing archive access rule: archiving a course denies protected course content, new playback authorization, assessments and progress mutations, including access associated with an existing purchase. Already issued playback authorization may remain valid for its existing maximum 600 seconds.
2. Keep course/lesson identifiers, independent grants, progress and immutable assessment/audit references. Archival itself does not delete or deidentify learning records. The separately approved account-deletion policy still applies when an account is deleted.
3. Recompute Community access from remaining effective course grants. Archiving one course does not revoke access independently supported by another eligible course or grant.
4. Archival does not itself issue a refund, cancel a payment or invent a refund entitlement. Support/refund requests remain subject to existing applicable terms and owner review. No new refund deadline, retention period or automatic financial mutation is introduced.
5. Restoration is an explicit republish operation that must pass current publication validation. Access derives from the still-valid grants and account state; restoration cannot override revocation, expiry, suspension or a terminal deletion. Historical progress/attempt identities remain stable.
6. Before an administrator archives a paid course, the authoring interface must display these access/history/Community/support/restoration consequences. Policy approval is recorded in source and tested; it is not a browser-provided bypass or an additional per-release approval ceremony.

Approval removes the unconditional source-level paid-publication placeholder once the corresponding validation, author warning and tests are implemented. It does not authorize an actual staging/production publication or release; the existing reviewed single-operator release procedure remains authoritative.
