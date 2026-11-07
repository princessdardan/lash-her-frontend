# Identity and account lifecycle brief

Owners: FE for identity/sessions/durable commands; Course and Community for receiver enforcement. Tasks: P2-01–P2-04/P2-11/P2-12 and P5-07. Inputs: [approved v1 contract](../../../contracts/api-integration/v1/README.md), current API schemas and isolated test fixtures. Outputs: owned schema/API/UI changes, durable lifecycle delivery and tested access/retention/export behavior. Deployed certification needs G1/P2-00.

## Invariants

- Immutable customer UUIDs are separate from admin identities/cookies. Customer Google/email-link sign-in does not weaken staff authorization. Email links are single use with 15-minute validity; provider linking requires proof of control. Marketing is optional.
- Preserve target token claims/audiences/capabilities, distinct service credentials, maximum 300-second user-token validity and 30-second skew. Existing playback tokens last 600 seconds. Do not add undocumented claims to the closed v1 shape; semantic changes use a reviewed contract version.
- Frontend revokes sessions and stops minting new customer tokens immediately on suspension/deletion. Receivers apply consecutive account commands transactionally and preserve terminal deletion tombstones. Old enrollment/payment events must not recreate identity or grant access contrary to lifecycle state.
- Existing v1 ordering, all-actions-to-both-receivers, exact replay-before-deleted rejection and separate Community sanctions remain authoritative; do not redesign them silently.

## Decisions before affected implementation

Record the denial bound for outstanding user tokens and in-flight requests, how receiver account state shortens that bound, retry/outage behavior while lifecycle delivery is delayed, and recovery ordering before access reopens. Session revocation alone is not immediate downstream revocation; document configured token/skew and already-issued playback windows to support and users where needed.

Dardan/FE supplies record-specific export/retention/deletion policy with qualified input where necessary. Choose authenticated export artifact expiry/access rules before implementing delivery. Do not invent statutory periods or put private content/bearer export links in commands/receipts. The existing archived-course denial remains; record its effect on paid learners/history/community/restoration and refund/support expectations before paid publication.

## Acceptance

Exercise expired/reused links, enumeration/throttling/safe returns, provider-link takeover, customer/admin and cross-account isolation, missing/wrong claims/capabilities, overlapping key rotation, CSRF/private caching, immediate session revocation and measured outstanding-token denial. Use real receiver enforcement, not frontend-only tests.

Race suspend/delete/restore with free grants, purchase delivery, Community events, token refresh and in-flight requests. Include unavailable receiver, sequence gap, replay after deletion, stale restore and new command after terminal deletion. Verify ordered recovery never reopens a deleted account. Validate private authenticated exports, expiry, required retention and all Community content/media/notification extensions in P5-07. Live provider results belong to P2-12; a schema publication is not runtime proof.
