# Chit Chats shipping policy decisions

Status: superseded as an approval model; retained as the P-01–P-11 selection record
Policy version: 2026-08-13, amended by `P-01-P-11-owner-only-2026-08-14`
Applies to: Lash Her product orders fulfilled through Chit Chats

The decision selections were recorded on 2026-08-13. The effective owner-operated approval model and conflicting-rule amendments are defined in [Product fulfillment policy P-01–P-11 — owner-operated amendment](./chitchats-shipping-policy-2026-08-14.md). That amendment takes precedence. Production checkout remains disabled until its separate readiness gates and staging evidence are complete.

Customer remedies in this document are minimum Lash Her commitments. They do not limit rights available under applicable consumer-protection law or card-network rules. Nataliea must record the required Privacy/Legal owner self-attestation before publication; it is not an independent review.

## Selection record

| Policy | Selected approach                                                                    |
| ------ | ------------------------------------------------------------------------------------ |
| P-01   | Option A — one-to-two-business-day SLA with 14:00 ET cutoff                          |
| P-02   | Option A — escalate, notify, then automatically refund                               |
| P-03   | Option A — equivalent substitution without consent; material changes require consent |
| P-04   | Option A — customer-first remedy schedule                                            |
| P-05   | Option A — Lash Her owns claims and fronts customer remedies                         |
| P-06   | Option A — provider recovery and customer refunds are separate financial events      |
| P-07   | Option A — signed address-change links with risk-based review                        |
| P-08   | Option A — business-hours manual-review coverage                                     |
| P-09   | Option A for 30 days at CAD 25/CAD 100, then Option D volume-based funding           |
| P-10   | Option D — terminal-date schedule with day-365 live and day-395 absolute caps        |
| P-11   | Option A — conditional signature with CAD 500 threshold                              |

## Definitions

- **Business day:** Monday through Friday, 09:00–17:00 America/Toronto, excluding Ontario statutory holidays and a day on which the owner-attested physical Chit Chats intake location has announced a closure. The persisted `branch_closure` calendar term covers a branch, drop spot, or mail-in hub and does not imply a provider branch ID.
- **Paid and cleared:** Helcim payment is reconciled, the address and required product shipping data are valid, and no payment-fraud hold is active.
- **Carrier handoff:** the first physical Chit Chats acceptance scan or receipt. Buying or printing a label is not carrier handoff.
- **Full refund:** merchandise, merchandise tax, and outbound shipping charged for the affected shipment, returned to the original payment method.
- **Equivalent substitute:** door-delivery service with end-to-end tracking, insurance covering the paid merchandise value up to the provider's published limit, and a provider delivery estimate whose latest date is no later than the selected service's latest date.
- **At-risk value:** the discounted merchandise amount plus applicable merchandise tax. Shipping is excluded.

## P-01 — Paid-to-carrier handling SLA

Selected decision (Option A):

- Orders paid and cleared by 14:00 ET on a business day must receive carrier handoff by 17:00 ET on the next business day.
- Orders paid after 14:00 ET are deemed received at 09:00 ET on the next business day and must receive carrier handoff by 17:00 ET on the following business day.
- Weekend and holiday payments are deemed received at 09:00 ET on the next business day.
- An announced closure of the owner-attested physical intake location pauses the handoff clock for that closure day. Staff must use another verified and newly attested intake location when practical; otherwise the customer-notification rule in P-08 applies.
- The public handling promise is **one to two business days after payment clears**. Transit time begins only after carrier handoff.
- A label-created or postage-requested state must never be represented to a customer as shipped.

Owner: Operations Lead  
Selection state: selected; owner approval pending

## P-02 — Postage failure and manual review after payment

Selected decision (Option A):

- Any failed, unknown, or ambiguous postage purchase enters `manual_review` immediately. Automated purchase retries stop until the provider state is reconciled.
- Staff must acknowledge the queue item within two coverage hours, reconcile it within four coverage hours, and resolve it no later than the original handoff deadline.
- Resolution means one of: confirmed original postage, an allowed substitute under P-03, or a full customer refund.
- If the original handoff deadline will be missed, notify the customer by that deadline and offer: an immediate full refund, an approved substitute, or an explicit choice to wait for a stated revised date.
- Without recorded customer consent to wait, an order still unresolved two business days after the original handoff deadline is automatically fully refunded.
- Provider credit, refund, or investigation timing never delays the customer remedy.

Owner: Operations Lead  
Selection state: selected; owner approval pending

## P-03 — Substitute service and customer consent

Selected decision (Option A):

- Staff may substitute without advance consent only when the service is an equivalent substitute, does not add signature or pickup requirements, does not introduce duties or brokerage, and does not change the destination or delivery country. Notify the customer when the substitution is purchased.
- Lash Her absorbs any higher postage cost.
- If the substitute costs at least CAD 1.00 less than the shipping amount charged, refund the difference to the original payment method.
- Customer consent is required before a service that is slower, requires signature or pickup, changes duty/brokerage exposure, or materially changes delivery conditions is purchased.
- End-to-end tracking and required insurance may not be waived by customer consent. If they are unavailable, use another provider with Business Owner approval or refund the order.
- Consent must be recorded through the original order email or a signed order-management link. No response within one business day results in the P-02 wait-or-refund process; silence is not consent.

Owner: Operations Lead  
Selection state: selected; owner approval pending

## P-04 — Shipment remedy schedule

Selected decision (Option A):

| Event                                                                                                              | Lash Her action                                                                                                                                                                       | Customer remedy                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No carrier movement for five calendar days, or shipment is two business days beyond the provider's latest estimate | Open an investigation and send an update. Continue updates every two business days.                                                                                                   | No merchandise refund while the carrier still confirms movement. If ultimately delivered at least five business days beyond the latest estimate, refund the outbound shipping charge to the original payment method as a service-recovery adjustment. |
| Shipment meets Chit Chats' loss-claim waiting period or the carrier confirms loss                                  | File the claim on the first eligible day.                                                                                                                                             | Customer chooses one replacement shipment at no charge or a full refund. Issue within two business days of eligibility/confirmation; do not wait for claim payment.                                                                                   |
| Customer reports damage                                                                                            | Request only the photos and packaging evidence required for the claim and file immediately. Ask for reports within seven calendar days of delivery without limiting statutory rights. | Replacement at no charge or full refund within two business days after sufficient evidence is received; do not wait for claim payment.                                                                                                                |
| Refused or unclaimed with no Lash Her/carrier error                                                                | Track the return and inspect within two business days after receipt.                                                                                                                  | Refund restockable merchandise and related tax after receipt. Original outbound shipping and actual return fees are not refunded and may be deducted only when disclosed and legally permitted.                                                       |
| Return to sender caused by customer-supplied address                                                               | Notify the customer and inspect the return.                                                                                                                                           | Customer may pay secure reshipping costs or receive the refused/unclaimed remedy. The current system cannot take a supplemental charge, so the interim process is refund then reorder.                                                                |
| Return to sender caused by Lash Her, label, or carrier error                                                       | Recover the parcel and pursue any provider claim.                                                                                                                                     | Customer chooses free reshipment or full refund. Lash Her absorbs outbound and return costs.                                                                                                                                                          |
| Returned parcel is lost or damaged while the provider's return coverage applies                                    | Lash Her owns the claim.                                                                                                                                                              | Apply the same lost/damaged remedy; do not make the customer wait for recovery.                                                                                                                                                                       |

Orders must not be marked delivered solely because a provider webhook is missing. Staff use carrier evidence and the audit trail when resolving a disputed state.

Owner: Business Owner  
Selection state: selected; owner approval pending

## P-05 — Insurance claim ownership and advance remedy

Selected decision (Option A):

- Lash Her owns the carrier relationship, investigation, claim filing, deadlines, evidence package, follow-up, and appeal.
- The customer supplies only reasonably available evidence such as non-receipt confirmation or damage photos.
- Lash Her provides the P-04 replacement or refund before carrier recovery. Carrier reimbursement belongs to Lash Her and offsets the loss; it is not a second customer payment.
- Staff file on the first eligible day and must not miss the provider's outer claim deadline.
- For orders above the service's insurable limit, automated fulfillment is blocked. The Business Owner must approve a fully insured alternative or refund the order.

Owner: Business Owner  
Selection state: selected; owner approval pending

## P-06 — Postage-refund and customer-refund matrix

Selected decision (Option A):

| Scenario                                                                             | Chit Chats action                                          | Customer payment action                                                                                          |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Customer cancellation before handoff and cancellation is permitted                   | Void/refund unused postage                                 | Full refund                                                                                                      |
| Duplicate label, label data error, or service change before handoff; order continues | Void/refund unused postage and buy the correct label       | No customer refund unless the replacement shipping charge is at least CAD 1.00 lower; then refund the difference |
| Postage cannot be obtained by the P-02 deadline                                      | Reconcile or request eligible postage refund independently | Full refund unless customer explicitly accepts a substitute or revised date                                      |
| Shipment already in transit                                                          | Do not request an unused-postage refund                    | Apply P-04; use a claim when eligible                                                                            |
| Lost or damaged                                                                      | File a claim; do not treat it as unused postage            | Replacement or full refund under P-04 before carrier recovery                                                    |
| Delayed but still moving                                                             | Investigate; insurance does not cover delay                | Shipping-charge remedy under P-04 when threshold is met                                                          |
| Customer-caused refused, unclaimed, or bad-address return                            | No unused-postage refund; reconcile return fees            | Apply the customer-caused P-04 remedy after return                                                               |
| Lash Her/carrier-caused return                                                       | Pursue eligible provider credit or claim                   | Free reship or full refund; Lash Her absorbs costs                                                               |
| Chit Chats refund is requested, pending, denied, or returned as account credit       | Record and reconcile it in the shipping ledger             | Do not delay, reverse, or condition the customer remedy on the provider result                                   |

Postage credits and customer refunds are separate financial events and require separate audit entries.

Owner: Finance Owner and Business Owner  
Selection state: selected; owner approval pending

## P-07 — Address changes, fraud review, and added cost

Selected decision (Option A):

- Address changes are accepted only before carrier handoff. After handoff, Lash Her may request a carrier intercept as a best effort but does not promise success.
- Authenticate a change through a single-use signed link sent to the original order email. Until that control exists, accept only a reply from the original order email that includes the order number and original destination postal code; a staff member must call back using the order phone number for high-risk changes.
- Do not accept address changes solely through social media, SMS, a new email address, or an inbound phone call.
- Mandatory fraud review applies to a country or province change, order at-risk value of CAD 150 or more, freight forwarder/reshipper destination, email mismatch, repeated change, or a change after postage purchase.
- A high-risk change requires Nataliea's action-and-target-bound step-up authentication, original-order-phone callback, authoritative provider evidence, structured rationale, a 15-minute cooling-off period, and separate immutable owner address-approval and fraud-clearance actions. Missing authoritative evidence blocks clearance.
- Lash Her absorbs added cost caused by its own error. A customer-caused increase uses a separately priced, expiring `address_increase` Helcim obligation. The original fulfillment remains held while the request is open; expired offers may be superseded and repriced. After the supplemental payment clears, Lash Her absorbs later purchase increases and refunds an eligible decrease once through the typed adjustment ledger.
- Once a label exists, staff must void/reconcile it before buying replacement postage. Never overwrite the audit history.

Implementation must follow the [signed address-change implementation plan](./chitchats-address-change-implementation-plan.md). The signed-link workflow is a production launch blocker; the email-reply procedure is an interim staging/manual fallback only.

Owner: Operations Lead and Payment/Fraud Owner  
Selection state: selected; owner approval pending

## P-08 — Manual-review coverage and escalation

Selected decision (Option A):

- Coverage is 09:00–17:00 ET on business days. Staff inspect the queue at 09:00, 13:00, and 16:00 at minimum.
- Queue item acknowledgment target: two coverage hours.
- Operations Lead escalation: four coverage hours after entry, or immediately when the handoff SLA is within four hours.
- Business Owner escalation: one business day after entry, any unknown successful postage purchase, any duplicate-charge risk, or any order likely to miss the handoff deadline.
- Customer notification is required as soon as a missed SLA is likely and no later than the original handoff deadline. Notify immediately when payment succeeded but fulfillment cannot proceed safely.
- Send an update every business day while fulfillment is blocked, even when provider state has not changed.
- Weekend/holiday emergency coverage is not assumed. A Friday after-cutoff order follows P-01; a known paid-order incident that could cause duplicate postage or loss of funds is escalated immediately to the Business Owner.

Owner: Operations Lead  
Selection state: selected; owner approval pending

## P-09 — Chit Chats credit auto-reload and emergency authority

Selected decision (Option A pilot, then Option D):

- For the first 30 production days, auto-reload is triggered below CAD 25 and reloads CAD 100.
- Maximum intended Chit Chats credit balance: CAD 500.
- Automated funding exposure limit: CAD 750 in a rolling 24-hour period and CAD 1,500 per calendar month.
- Funding source: a dedicated Lash Her business credit card designated by the Business Owner. Personal cards and debit cards are prohibited.
- The Operations Lead may make one emergency top-up of up to CAD 250 per rolling 24 hours and must record the reason. A second top-up or any larger amount requires Business Owner approval.
- A failed reload or balance below the next two business days' forecast triggers immediate manual review. Do not repeatedly submit postage purchases against insufficient credit.
- Because Chit Chats exposes threshold and reload amount but not all desired exposure controls, card alerts, issuer limits, and a daily balance check enforce the remaining limits.
- After 30 production days, Finance moves to Option D and reviews it monthly using trailing 30-day settled postage: threshold equals two average business days of postage and reload amount equals five average business days of postage. Round each upward to the next CAD 25. Apply a CAD 25–250 threshold guardrail and a CAD 100–1,000 reload guardrail. The CAD 500 intended-balance limit and funding-exposure limits remain in force unless Finance and the Business Owner approve revised limits. If a calculated reload would exceed an approved limit, require manual approval instead of reloading automatically.

Owner: Finance Owner  
Selection state: selected; owner approval pending

## P-10 — Absolute PII-retention limit

Selected decision (Option D):

- Redact PII at the earlier of 180 days after the order/shipment becomes terminal or **365 calendar days after the source record was created**.
- No customer or shipment PII may remain recoverable in Lash Her-controlled production systems more than **395 calendar days after the source record was created**, regardless of payment, order, shipment, claim, refund, or manual-review status.
- Live databases and replicas must enforce the day-365 outer cap using `checkout_orders.created_at` and `product_shipments.created_at`. Backups must expire within 30 days so the absolute recoverability limit is day 395.
- Abandoned quote PII remains on the shorter 30-day schedule.
- Logs, exports, email-system metadata, support attachments, and downloaded labels must use deletion schedules that cannot exceed the same absolute day-395 limit. Signed label URLs are never persisted.
- Non-PII accounting and audit facts may be retained under the applicable financial-record schedule: internal IDs, timestamps, amounts, currency, status, provider identifiers, tracking status, and redaction evidence. Free text and raw provider payloads must be scrubbed because they can contain PII.
- Open or non-terminal status does not extend the deadline. There is no automatic legal-hold exception. Any legally required exception must be proposed and approved by Nataliea as a new policy version, with the Privacy/Legal owner self-attestation recorded before day 365; this is not an independent review and cannot extend the existing record's cap.
- The retention job records redaction counts and alerts on any overdue record. A daily query must prove that no unredacted record is beyond day 365.
- Amendment `P-01-P-11-owner-only-p10-precap-2026-08-15` schedules owner/customer notice at day 350 and begins default refund/cancellation execution at day 360. This five-day buffer exists because the certified Helcim refund request needs the original checkout IP, which must be redacted unconditionally at day 365. It is an internal reconciliation buffer, not a provider SLA. Activation and customer notice are required because execution before day 365 shortens the prior default-action window; the hard cap itself is unchanged.

The implementation now applies the 180-day terminal schedule and 365-day live cap. Production approval still requires evidence that database backups expire within 30 days and that downstream logs, exports, Resend history, downloaded labels, and support artifacts cannot exceed day 395.

Owner: Privacy Owner  
Selection state: selected; owner approval pending

## P-11 — Signature for high-value and high-risk orders

Selected decision (Option A, CAD 500 threshold):

- Signature remains disabled by default because Chit Chats signature availability is limited by service and it adds delivery friction.
- Signature is required when at-risk value is CAD 500 or more **or** fraud review classifies the order as high risk, but only when the chosen destination/service supports it.
- If signature is required and unavailable on an otherwise eligible Chit Chats service, automated postage purchase is blocked. The Business Owner must approve a signature-capable, fully insured alternative provider/service or fully refund the order.
- Customer consent is required if the original checkout did not disclose the signature requirement. After the requirement is disclosed in checkout, purchase acceptance is consent.
- A customer may not waive signature on a high-risk order. The Business Owner may waive it for a high-value, low-risk order only with a documented reason and proof that insurance remains valid.
- Orders above the carrier's insurance limit remain blocked under P-05 regardless of signature.

Owner: Payment/Fraud Owner and Business Owner  
Selection state: selected; owner approval pending

## Required system controls before production enablement

| Control                                                                     | Current state                                                                                         | Launch effect                                         |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Configurable cutoff/business calendar and handoff SLA timestamps            | Implemented in migration 0033 and the policy worker; branch-closure data and staging evidence pending | Blocker until configured and verified                 |
| Manual-review timers, alerts, escalation, and customer-notification audit   | Implemented; role assignments and Resend staging evidence pending                                     | Blocker until verified                                |
| Substitute equivalence test, consent record, and shipping-difference refund | Implemented with fail-closed delivery parsing and signed decisions; Helcim certification pending      | Blocker until verified                                |
| Customer replacement/refund workflow separate from postage refund           | Implemented with an independent Helcim refund ledger and shipment generations                         | Blocker until Helcim certification                    |
| Claim case, deadline, evidence, and remedy audit                            | Implemented as a local durable queue; Chit Chats claim filing remains manual by API limitation        | Blocker until service policies are configured         |
| Authenticated address-change workflow and fraud approvals                   | Implemented with signed links, provider reconciliation, and enhanced owner-only high-risk controls    | Blocker until owner Security self-attestation         |
| Credit balance/reload alerts and exposure controls                          | Recording and authority controls implemented; dashboard/card controls remain external evidence        | Blocker until external setup is recorded              |
| Absolute created-date PII redaction and overdue alert                       | Implemented at 180-day terminal / 365-day live limits                                                 | Blocker until backup and downstream deletion evidence |
| High-value/high-risk hold and conditional signature workflow                | Implemented at CAD 500 with service capability and insurance filtering                                | Blocker until eligible services are reviewed          |

## Carrier constraints used for these decisions

Verified against Chit Chats material on 2026-08-13:

- Chit Chats insurance covers eligible loss and damage, not late delivery. Coverage limits and eligible services vary. [Insurance coverage](https://support.chitchats.com/en/support/solutions/articles/47001286217-what-is-chit-chats-insurance-what-does-it-cover-)
- Claim waiting periods vary by destination; Chit Chats states an outer submission deadline of 90 days after postage purchase for its insurance. [Claim timing](https://support.chitchats.com/en/support/solutions/articles/47000426954-when-should-i-file-a-claim-)
- Unused-postage refunds must be initiated before shipping, eligibility and timing vary by postage type, and approved refunds return as Chit Chats credits. [Unused postage refunds](https://support.chitchats.com/en/support/solutions/articles/47000426938-can-i-refund-unused-postage-)
- Signature confirmation is available only for specified services and adds a fee. [Signature confirmation](https://support.chitchats.com/en/support/solutions/articles/47000427022-what-is-signature-confirmation-)
- Auto-reload uses a configured balance threshold and reload amount charged to a credit card. [Auto-reload](https://support.chitchats.com/en/support/solutions/articles/47000427096-how-do-i-set-up-an-auto-reload-)
- Return processing can add carrier/provider fees. [Return shipment fees](https://support.chitchats.com/en/support/solutions/articles/47000427145-are-there-fees-for-return-shipments-)
- API behavior remains governed by the current [Chit Chats API v1 documentation](https://chitchats.com/docs/api/v1#section/Overview).

Carrier terms can change. Operations must re-verify claim deadlines, insurance limits, eligible services, refund windows, return fees, and signature availability quarterly and record the review date.

## Archived approval model

The former distinct-role approval table is non-operative and intentionally omitted. Nataliea Lavoie permanently holds the Business Owner, Operations, Finance, Payment/Fraud, Privacy/Legal, and Security duties. The effective record must store her owner approval plus distinct Privacy/Legal and Security self-attestations. None may be described as independent review. See policy version `P-01-P-11-owner-only-2026-08-14` for the effective control and remaining launch gates.
