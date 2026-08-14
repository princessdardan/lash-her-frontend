# Chit Chats shipping operations

## Policy dependency

The effective rules are [Product fulfillment policy P-01–P-11 — owner-operated amendment](./chitchats-shipping-policy-2026-08-14.md), together with the retained selections in [Chit Chats shipping policy decisions](./chitchats-shipping-policy-decisions.md). Nataliea Lavoie holds every operating and self-attestation role. Provider certification, tax approval, configuration, CMS readiness, staging acceptance, and operational evidence remain pending launch gates. P-07 follows the [signed address-change implementation plan](./chitchats-address-change-implementation-plan.md) as amended by the effective policy.

## Scope

The integration supports one parcel per product order to Canada and, behind a separate gate, the United States. Customers choose a live Chit Chats rate that includes full tracking and confirmed insurance. Helcim charges discounted merchandise plus the complete Chit Chats `payment_amount`. Staff confirms measured weight and ship date before buying postage. Lash Her absorbs quote-to-purchase variance.

It does not implement split shipments, partial fulfillment, batch labels, or in-application claim submission. Claims are tracked locally and filed manually in Chit Chats. Supplemental charges use typed child payment obligations; they must remain disabled until the product-tax and Helcim certification gates pass.

## Rollout gates

1. Obtain all approvals in `chitchats-shipping-policy-decisions.md` and implement its launch-blocking controls.
2. Apply migrations `0032_fat_roulette.sql` and `0033_bored_dexter_bennett.sql` with checkout disabled and policy enforcement off.
3. Review the seeded `small-mailer`, `medium-parcel`, and `large-parcel` profiles in `shipping_package_profiles`. Change dimensions, tare weight, capacity, and maximum weight to match physical packaging before quoting.
4. Deploy the Sanity schema to staging.
5. Populate every purchasable product and variant with fulfillment mode, item weight, packing units, customs description, and country of origin. A variant shipping object is a complete override; partial overrides are not merged.
6. Dry-run and apply the product confirmation template update with `npm run resend:seed-templates` and `npm run resend:seed-templates -- --apply` so shipping and merchandise totals are both rendered.
7. Configure a Chit Chats staging account, return address, branch, label format, account credits, and API token.
8. Assign every policy duty to Nataliea Lavoie, configure at least 21 months of statutory/observed dates and branch closures, and review each enabled service's insurance, signature, and claim limits. Rates fail closed when this data is absent or stale.
9. Record the external Chit Chats CAD 25 threshold / CAD 100 reload setup, dedicated business card, issuer alerts, CAD 750 rolling-day control, CAD 1,500 monthly control, and 30-day pilot start.
10. Configure the new encryption/token secrets and start with `SHIPPING_POLICY_ENFORCEMENT_MODE=observe`. `CHITCHATS_CHECKOUT_ENABLED=true` is rejected unless policy mode is `enforce`.
11. Certify full, partial, and ambiguous Helcim refunds using original encrypted checkout IPs.
12. Exercise the staging matrix below before enabling Canada in production.
13. Keep U.S. shipping disabled until Chit Chats certifies the DDU service allowlist and every U.S.-approved SKU has reviewed 10-digit HTS, origin, manufacturer, insurance, tariff, and FDA metadata where applicable.

Production deployments reject a Chit Chats staging endpoint. There is no production mock mode.

## Staging matrix

- Each package tier at its capacity and maximum weight boundary.
- Multiple quantities and mixed products.
- Manual product discounts and product promotion codes, verifying customs values equal discounted merchandise and exclude shipping/tax.
- Canadian postal codes and provinces.
- U.S. address rejected while the U.S. flag is disabled.
- Quote expiry, address/cart/promotion changes, and provider repricing.
- Helcim success, decline, cancellation, client callback loss, and webhook recovery.
- Repeated payment callback/webhook delivery creates one fulfillment activation.
- Repeated label clicks create one buy request.
- Selected service loss requires an explicit alternative and reason.
- `postage_requested`, purchase failure, account-credit failure, ambiguous network failure, and manual-review recovery.
- Label PDF proxy content type, size, redirect, and host validation.
- Received/in-transit, exception, delivered, void/refund, and duplicate polling notifications.

## Operations

The admin Orders workspace shows fulfillment state. `ready for staff` permits label purchase. Staff enters the actual packed weight and expected Chit Chats receipt date. Rates are refreshed before purchase. The customer-selected service is retained when available; otherwise the endpoint returns the current insured tracked alternatives and requires an audited reason.

`manual review` means the external outcome could not be determined safely. Do not retry buy/refund blindly. Search Chit Chats by the stored `public_reference` or provider shipment ID, reconcile the provider state, then update the local record through a controlled repair procedure. The policy worker alerts at two coverage hours, escalates at four, and preserves the original handoff and auto-refund deadlines.

The label endpoint fetches a fresh signed provider URL in memory and proxies a validated PDF. Signed label URLs must not be copied into logs or PostgreSQL.

The one-minute shipping cron polls purchase and tracking state and sends accepted, exception, and delivered emails. The 15-minute policy cron handles SLA/manual-review escalation, decision deadlines, remedies, returns, refunds, funding reviews, and policy reminders. Both accept `CHITCHATS_WORKER_CRON_SECRET` or the configured Vercel `CRON_SECRET`. Abandoned quote PII is redacted after 30 days. Shipping PII is redacted at the earlier of 180 days after all linked work is terminal or 365 days after order creation.

Postage refund is separate from a Helcim customer refund. The postage action requests only Chit Chats credit. Customer remedies use `product_order_refunds` with local balance locking and a stable UUID idempotency key. An unknown Helcim outcome is reconciled and never resubmitted blindly.

## External evidence register

Before production enablement, attach dated evidence for:

- Chit Chats auto-reload values and dedicated-card issuer controls.
- All active role assignments, branch closures, and service-policy review dates.
- Helcim sandbox full/partial refunds and ambiguous-outcome reconciliation.
- Database backup expiry of 30 days or less.
- Log, export, Resend, label-download, and support-artifact deletion settings that make PII unrecoverable by day 395.
- Observe-mode deadline comparison and the completed staging fault-injection matrix.

## Rollback

Set `CHITCHATS_CHECKOUT_ENABLED=false` to stop new quotes and product checkouts that depend on shipping. Leave `CHITCHATS_SHIPPING_ENABLED=true`, the cron route, and credentials deployed until all purchased/accepted shipments are terminal so tracking and customer notifications continue. Do not delete provider shipment IDs or local shipment history during rollback.
