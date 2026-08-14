# Product fulfillment policy P-01–P-11 — owner-operated amendment

Status: effective operating policy; production admission remains blocked pending readiness evidence  
Policy version: `P-01-P-11-owner-only-2026-08-14`  
Effective date: 2026-08-14  
Owner: Nataliea Lavoie

This version retains P-01 through P-11 from the 2026-08-13 selection record except where this amendment changes them. This document takes precedence wherever the earlier record, address-change plan, or operations guide requires distinct people, independent review, DDP, 18 months of calendar coverage, or refund-and-reorder instead of a supplemental obligation.

## Roles and approval control

Nataliea Lavoie permanently holds the Business Owner, Operations, Finance, Payment/Fraud, Privacy/Legal, and Security roles. Privacy/legal and security acceptance are owner self-attestations and must not be represented as independent review.

Distinct-person approvals are replaced by enhanced owner-only review. A high-risk address or fraud decision requires all of:

- Step-up authentication bound to the specific incident and action.
- A 15-minute cooling-off period before clearance.
- Structured provider evidence and rationale.
- Separate immutable address-approval and fraud-clearance actions.
- A callback to the original order phone before a high-risk address approval.
- No clearance while authoritative provider evidence is unavailable.

Historical review does not clear a new risk incident.

## Payment risk and review deadlines

Only certified explicit AVS and CVV matches clear fulfillment automatically. Missing, mismatched, unsupported, or unknown evidence blocks fulfillment and alerts Nataliea. The response target is two business hours. An unresolved case continues under P-02's handoff and signed wait-or-full-refund deadlines.

Customer language after a captured but held payment is: “Payment received; fulfillment confirmation is under review.” It must not mention fraud or promise preparation.

## Wait extensions and address supplements

A customer may sign multiple wait extensions. Each extension states a new date, is signed before the prior deadline expires, and supersedes without deleting prior decisions.

A customer-caused address change awaiting an `address_increase` payment obligation is exempt from P-02's automatic handoff refund while the offer is open or repricing remains available. It is not exempt from P-10. Old 24-hour offers are marked `superseded`; the address request remains open and may receive a new quote.

At days 335 and 350, unresolved orders approaching P-10 alert Nataliea. By day 365 the order must be fulfilled, restored to the original safe address, or fully refunded and cancelled. If none has occurred, the system defaults to full refund and cancellation before redaction. All PII-bearing child records are redacted independently; a parent redaction marker cannot suppress child cleanup.

## Calendar changes

Deadlines use immutable policy and calendar versions. Calendar changes affect new calculations. A change that shortens an existing commitment requires an owner proposal, step-up approval, customer notification, and a new policy version; existing deadline snapshots are never silently rewritten. Readiness requires at least 21 months of statutory, observed, and branch-closure coverage.

## U.S. duties and product tax

U.S. checkout is DDU. Rate discovery uses `postage_type: unknown` and does not request provider DDP or send a VAT reference. Duties, import taxes, and brokerage exposure are shown as an informational notice before payment and snapshotted on the order; they are not product sales tax and require no separate checkbox.

Product tax is a separate mandatory launch gate. No primary or supplemental product payment may be admitted until a versioned tax decision covers merchandise, outbound shipping, supplemental charges, U.S. orders, and component-level refunds. Tax calculation remains a separate workstream.

## Admission and observe mode

New automated checkout is admitted only when the readiness service proves the checkout flag, `enforce` mode, additive schema, canonical origin, strong secrets, provider configuration and certification, roles, packages, service policies, current funding evidence, 21 months of calendar coverage, an effective Helcim certification, an approved product-tax policy, and complete destination-specific CMS metadata. U.S. orders require separate U.S. Chit Chats certification.

`observe` mode is read-only: it may calculate, emit telemetry, and alert, but may not create cases, expire decisions, issue refunds, or mutate operational state. Disabling checkout rejects new quotes and product checkout submissions; it never converts an in-progress shipping checkout into merchandise-only checkout.

## Readiness record

The policy is effective for operating decisions but does not by itself authorize production checkout. Chit Chats/Helcim certification, tax approval, CMS metadata, package/service/calendar/funding configuration, staging acceptance, actionable queues, and retention evidence remain separate launch gates. Checkout flags remain disabled until every applicable gate is current.
