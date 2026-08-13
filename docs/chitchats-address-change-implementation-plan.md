# Signed address-change implementation plan

Status: implemented; role approval and staging security acceptance pending  
Policy dependency: P-07 in `chitchats-shipping-policy-decisions.md`  
Production effect: remains a launch blocker until acceptance evidence is recorded

## Outcome

Allow a customer to propose a shipping-address change before carrier handoff through a single-use link delivered only to the original order email. Preserve the original address and every decision in an audit trail, require risk-based staff approval, and prevent an address mutation from bypassing postage reconciliation.

The implementation must never collect card details. Until a secure supplemental-charge flow exists, a customer-requested change that increases the amount owed requires a full refund and a new checkout.

## Workflow

1. A staff member with `fulfillment:manage` starts an address-change request from the protected Orders workspace.
2. The server verifies that the order is paid, not redacted, and has not received carrier handoff. It creates a cryptographically random single-use token, stores only its keyed hash, and emails the raw link to the order's original email address.
3. The initial link exchange sets a short-lived `HttpOnly`, `Secure`, `SameSite=Strict` cookie and redirects to a clean URL so the bearer token is not retained in browser history, referrers, analytics, or application logs.
4. The customer sees the order reference and a masked current address, enters the proposed address, and submits it. The server validates origin, token state, expiry, order binding, address shape, and supported destination.
5. Submission atomically consumes the token. Reuse, expiry, revocation, or a second submission returns a generic failure without exposing order details.
6. The risk engine records triggered rules. A low-risk request made before postage purchase can be approved by one authorized staff member. A high-risk request requires two distinct approvals, including the Operations Lead or Business Owner.
7. Approval does not overwrite history. It records old and new snapshots, actor IDs, timestamps, risk reasons, and the operational result.
8. The original order email receives notifications when the request is submitted and when it is approved, rejected, expired, or cancelled.

## State and persistence

Create `product_order_address_change_requests` in PostgreSQL with:

- Request and order IDs; status: `pending_customer`, `submitted`, `review_required`, `approved`, `rejected`, `expired`, `revoked`, `cancelled`, or `applied`.
- Keyed token hash, expiry, consumed timestamp, revocation timestamp, and attempt counters. Never store the raw token.
- Original address snapshot, proposed address snapshot, normalized address fingerprint, and customer-provided reason.
- Risk flags, risk score/classification, review notes, first and second approver IDs/timestamps, and applied timestamp.
- Postage state at request/submission/application time, added-cost result, and links to any void/refund/replacement shipment operations.
- Creation/update timestamps and `redacted_at`.

Add immutable operational audit events for link creation, email claim/send result, token consumption, risk classification, each approval/rejection, address application, quote invalidation, postage reconciliation, expiration, and revocation. Audit payloads must be allowlisted and must not duplicate full PII unnecessarily.

The proposed address and token metadata follow P-10: redact at the earlier terminal schedule, enforce the day-365 live-data cap, and ensure backup expiry by day 395.

## Security controls

- Generate at least 256 bits of entropy with `crypto.randomBytes`; encode base64url.
- Hash with HMAC-SHA-256 using a dedicated `ADDRESS_CHANGE_TOKEN_SECRET`, separate from checkout and Chit Chats secrets. Compare fixed-length values safely.
- Default token lifetime: 30 minutes. Issuing another link revokes every unused link for the order.
- Permit at most three link issuances per order per 24 hours and five validation/submission attempts per IP per hour, with a global abuse circuit breaker.
- Use generic responses for unknown orders, invalid tokens, expired tokens, and already-used tokens.
- Require same-origin POSTs, restrictive CSP/referrer policy, no third-party scripts on the form, and `Cache-Control: no-store` throughout the flow.
- Never place the raw token, full address, or signed link in logs, analytics, error reporting, audit entries, or database payload dumps.
- Bind the request to the order ID and original order email. Do not allow the link to change the customer email.
- Recheck order and shipment state inside the final application transaction to prevent a race with postage purchase or carrier acceptance.

## Fraud classification

Always require manual review when any selected P-07 condition applies:

- Country or province changes.
- At-risk value of CAD 150 or more.
- Known freight forwarder, reshipper, parcel locker, or suspicious address pattern.
- Email mismatch or request received from a channel other than the signed flow.
- Repeated address changes or a previously revoked/expired request.
- Postage has already been purchased.

High-risk requests require two distinct approvers, one of whom has the Operations Lead or Business Owner role. The system must prohibit self-approval from satisfying both approvals.

## Shipment-state behavior

| Shipment condition                                                          | Required behavior                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No postage/provider shipment created                                        | Apply approved address transactionally, update both checkout and shipment destination snapshots, invalidate old quotes/fingerprints, and obtain new rates.                                                                                      |
| Provider shipment created but postage not purchased                         | Update the provider shipment or replace it safely, invalidate old rates, and record provider identifiers before applying locally.                                                                                                               |
| Postage purchased/label ready but no carrier handoff                        | Do not apply immediately. Move to manual review, request eligible void/refund, reconcile the provider outcome, then create/requote against the approved address. If additional customer payment is required, refund and require a new checkout. |
| `accepted`, `in_transit`, `delivered`, or other evidence of carrier handoff | Reject the normal address-change path. Record a best-effort intercept/return case; never promise that the address can be changed.                                                                                                               |
| Provider outcome is ambiguous                                               | Stop automation and enter `manual_review`; do not buy replacement postage until reconciliation proves that duplicate shipment/postage cannot occur.                                                                                             |

Address application and shipment transition must use a database transaction with optimistic state checks. An approval becomes stale if order or shipment state changes before application and must return to review.

## Application surfaces

- Protected Orders UI: start/resend/revoke link, display expiry and risk state, review a masked diff, approve/reject, perform second approval, and show postage reconciliation state.
- Customer route: `/orders/address-change` with token exchange, clean form URL, submission confirmation, and expired/invalid states.
- Admin API: create/resend/revoke, first approval, second approval, rejection, and apply/reconcile actions guarded by `fulfillment:manage` plus role checks.
- Customer API: token exchange, request read, and submission endpoints with rate limits and generic errors.
- Transactional email: original-email link, submission alert, approval/rejection, expiry, and final address-change confirmation.
- Operations queue: unresolved request age, SLA deadline, risk class, approvers required, and linked postage/manual-review state.

## Implementation sequence

1. Add the schema, enum/state model, indexes, retention fields, and migration. Add repository methods with atomic token consumption and optimistic state transitions.
2. Add token generation/exchange, validation, rate limits, origin/referrer protections, and security-focused unit tests.
3. Add customer routes and transactional email templates. Confirm that messages always use the immutable original order email.
4. Add fraud rules and two-person approval enforcement, including explicit role checks and audit events.
5. Add shipment orchestration for quote invalidation, provider update/replacement, purchased-label reconciliation, and handoff rejection.
6. Add the protected Orders UI and manual-review queue integration.
7. Add P-10 cleanup for address-change records and overdue-retention alerts.
8. Run the staging acceptance matrix and complete an independent security/privacy review before removing the launch blocker.

## Required tests

- Token entropy/format, keyed hashing, 30-minute expiry, revocation, single use, atomic double-submit handling, and clean-URL exchange.
- Enumeration resistance, rate limiting, same-origin enforcement, cache/referrer headers, and confirmation that raw tokens/PII never enter logs.
- Original-email delivery and notification behavior; email address cannot be changed by this flow.
- Every fraud trigger, distinct two-person approval, stale approval, prohibited self-double-approval, and role authorization.
- Concurrent address approval versus postage purchase/acceptance; exactly one safe outcome.
- Quote invalidation and recalculation; provider update/replace behavior; bought-label void/refund and ambiguous-outcome manual review.
- Customer-caused versus Lash-Her-caused added cost and the refund/reorder fallback.
- Day-365 live redaction, day-395 recoverability limit, shorter terminal deletion, and abandoned/expired request cleanup.
- Playwright flows for ordinary approval, high-risk two-person approval, expiry, rejection, already-used link, and post-handoff denial.

## Acceptance criteria

- Only possession of a valid link delivered to the immutable original order email permits customer submission.
- Each link is short-lived, revocable, single-use, rate-limited, and absent from stored/logged plaintext.
- No address change can silently bypass fraud review, postage reconciliation, customer cost rules, or carrier-handoff restrictions.
- Checkout and shipment address snapshots cannot diverge after a successful application.
- The original address, proposed address, approvals, provider effects, and final result are auditable until P-10 redaction.
- All required tests pass in staging, security/privacy reviewers sign off, and the production launch checklist records evidence.
