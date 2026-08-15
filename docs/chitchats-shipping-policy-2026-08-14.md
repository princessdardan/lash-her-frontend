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

### P-10 pre-cap execution amendment — version `P-01-P-11-owner-only-p10-precap-2026-08-15`

The day-365 default cannot safely initiate a Helcim refund because the certified refund request requires the encrypted originating checkout IP while P-10 requires that IP to be irreversibly removed by day 365. The amended schedule therefore preserves the day-335 warning and uses day 350 as the owner/customer notice date. If the order remains unresolved, default full-refund and cancellation processing begins at day 360. The five-day interval is an internal execution and provider-reconciliation buffer; it is not represented as a Helcim SLA. The unconditional day-365 PII cap and day-395 recoverability cap do not change.

Activation requires Nataliea's action-bound step-up approval and owner-only Privacy/Legal, Security, and Operations self-attestations. Existing affected customers receive a durable notice before day 360 stating the new execution date and policy version. The system never retains or fabricates an IP after the hard cap. Any refund still ambiguous at day 365 becomes an owner/provider reconciliation obligation while fulfillment is operationally terminated and PII redaction proceeds independently.

## Calendar changes

Deadlines use immutable policy and calendar versions. Calendar changes affect new calculations. A change that shortens an existing commitment requires an owner proposal, step-up approval, customer notification, and a new policy version; existing deadline snapshots are never silently rewritten. Readiness requires at least 21 months of statutory, observed, and physical-intake-location closure coverage. The persisted calendar kind `branch_closure` means an announced closure of the physical branch, drop spot, or mail-in hub selected in the active intake-location attestation; it is not a provider branch-ID reference.

## U.S. duties and product tax

U.S. checkout is DDU. Rate discovery uses `postage_type: unknown` and does not request provider DDP or send a VAT reference. Duties, import taxes, and brokerage exposure are shown as an informational notice before payment and snapshotted on the order; they are not product sales tax and require no separate checkbox.

Product tax is a separate mandatory launch gate. No primary or supplemental product payment may be admitted until a versioned tax decision covers merchandise, outbound shipping, supplemental charges, U.S. orders, and component-level refunds. Tax calculation remains a separate workstream.

## Admission and observe mode

New automated checkout is admitted only when the readiness service proves the checkout flag, `enforce` mode, additive schema, canonical origin, strong secrets, provider configuration and certification, roles, packages, service policies, current funding evidence, 21 months of calendar coverage, an effective Helcim certification, an approved product-tax policy, and complete destination-specific CMS metadata. Provider configuration includes an allowlisted `CHITCHATS_REGION` and a current owner-attested physical intake location whose provider environment, client ID, and region exactly match runtime configuration. U.S. orders require separate U.S. Chit Chats certification.

`observe` mode is read-only: it may calculate, emit telemetry, and alert, but may not create cases, expire decisions, issue refunds, or mutate operational state. Disabling checkout rejects new quotes and product checkout submissions; it never converts an in-progress shipping checkout into merchandise-only checkout.

## Readiness record

The policy is effective for operating decisions but does not by itself authorize production checkout. Chit Chats/Helcim certification, tax approval, CMS metadata, package/service/calendar/funding configuration, staging acceptance, actionable queues, and retention evidence remain separate launch gates. The physical intake location is owner-attested private readiness evidence, not a provider API identifier. It expires no later than 90 days after attestation and must never be seeded or inferred from region, account, address, or legacy branch configuration. Checkout flags remain disabled until every applicable gate is current.
