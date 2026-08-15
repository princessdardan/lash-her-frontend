# Chit Chats shipping operations

## Policy dependency

The effective rules are [Product fulfillment policy P-01–P-11 — owner-operated amendment](./chitchats-shipping-policy-2026-08-14.md), together with the retained selections in [Chit Chats shipping policy decisions](./chitchats-shipping-policy-decisions.md). Nataliea Lavoie holds every operating and self-attestation role. Provider certification, tax approval, configuration, CMS readiness, staging acceptance, and operational evidence remain pending launch gates. P-07 follows the [signed address-change implementation plan](./chitchats-address-change-implementation-plan.md) as amended by the effective policy.

## Scope

The integration supports one parcel per product order to Canada and, behind a separate gate, the United States. Customers choose a live Chit Chats rate that includes full tracking and confirmed insurance. Helcim charges discounted merchandise plus the complete Chit Chats `payment_amount`. Staff confirms measured weight and ship date before buying postage. Lash Her absorbs quote-to-purchase variance.

It does not implement split shipments, partial fulfillment, batch labels, or in-application claim submission. Claims are tracked locally and filed manually in Chit Chats. Supplemental charges use typed child payment obligations; they must remain disabled until the product-tax and Helcim certification gates pass.

## Rollout gates

1. Obtain all approvals in `chitchats-shipping-policy-decisions.md` and implement its launch-blocking controls.
2. Apply every migration through the last entry of `drizzle/meta/_journal.json` with checkout disabled and policy enforcement off. The shipping lineage begins at `0032_fat_roulette.sql` and `0033_bored_dexter_bennett.sql`, but those are not the release target. Never edit already-deployed migrations. Before enablement, the journal timestamp returned by `select max(created_at) from drizzle.__drizzle_migrations` must equal the final journal entry.
3. Review the seeded `small-mailer`, `medium-parcel`, and `large-parcel` profiles in `shipping_package_profiles`. Change dimensions, tare weight, capacity, and maximum weight to match physical packaging before quoting.
4. Deploy the Sanity schema to staging.
5. Populate every purchasable product and variant with fulfillment mode, item weight, packing units, customs description, and country of origin. A variant shipping object is a complete override; partial overrides are not merged.
6. Dry-run and apply the product confirmation template update with `npm run resend:seed-templates` and `npm run resend:seed-templates -- --apply` so shipping and merchandise totals are both rendered.
7. Configure a Chit Chats staging account, return address, account region, label format, account credits, and API token. Set `CHITCHATS_REGION` to the allowlisted value corresponding to that account setting; it is not a provider branch ID.
8. Assign every policy duty to Nataliea Lavoie, record the physical intake location through the owner-attestation workflow, configure at least 21 months of statutory/observed dates and physical-intake-location closures, and review each enabled service's insurance, signature, and claim limits. Rates fail closed when this data is absent or stale.
9. Record the external Chit Chats CAD 25 threshold / CAD 100 reload setup, dedicated business card, issuer alerts, CAD 750 rolling-day control, CAD 1,500 monthly control, and 30-day pilot start.
10. Configure the new encryption/token secrets and start with `SHIPPING_POLICY_ENFORCEMENT_MODE=observe`. `CHITCHATS_CHECKOUT_ENABLED=true` is rejected unless policy mode is `enforce`.
11. Certify full, partial, and ambiguous Helcim refunds using original encrypted checkout IPs.
12. Exercise the staging matrix below before enabling Canada in production.
13. Keep U.S. shipping disabled until Chit Chats certifies the DDU service allowlist and every U.S.-approved SKU has reviewed 10-digit HTS, origin, manufacturer, insurance, tariff, and FDA metadata where applicable.

Production deployments reject a Chit Chats staging endpoint. There is no production mock mode.

## Region and physical intake location

`CHITCHATS_REGION` is an allowlisted operational account setting. Use exactly one of:

- `british_columbia`
- `alberta_saskatchewan`
- `ontario_manitoba`
- `quebec`
- `atlantic`

The region must describe the matching Chit Chats account and where parcels first enter its network. It is part of the application's readiness identity together with `CHITCHATS_ENVIRONMENT` and `CHITCHATS_CLIENT_ID`; it is not a documented Chit Chats API branch identifier and must not be sent as one. Do not recreate `CHITCHATS_BRANCH_ID` unless Chit Chats supplies documentation for a provider-defined identifier and the exact API field or operation that consumes it.

The selected branch, drop spot, or mail-in hub is a separate owner-attested readiness record in private PostgreSQL. Nataliea must use recent step-up authentication and record the location type, verified name, full address, evidence reference, rationale, current policy version, provider environment, client ID, and region. The attestation is valid for at most 90 days. Readiness fails if it expires, is revoked, belongs to a different owner or policy version, or does not exactly match the configured environment, client ID, and region.

Never seed, infer, or backfill this record from `CHITCHATS_REGION`, a return address, a client account, public location search, or a former `CHITCHATS_BRANCH_ID`. Obtain authoritative current evidence, then attest. A location, account, environment, client ID, region, owner, or effective-policy change requires revocation or supersession and a new attestation. Preserve prior records as immutable evidence.

For an existing deployment, use this order while checkout remains disabled and enforcement is `off` or `observe`:

1. Add the allowlisted `CHITCHATS_REGION` value to the target environment before deploying code that requires it. Keep the existing `CHITCHATS_BRANCH_ID` temporarily if the currently deployed version still validates it.
2. Apply the additive intake-location migration and verify migration state.
3. Deploy the application version that reads `CHITCHATS_REGION` and the readiness record.
4. Nataliea creates the environment-specific physical-intake-location attestation and readiness is rechecked.
5. After the new deployment is healthy and the attestation matches, remove obsolete `CHITCHATS_BRANCH_ID` from the environment.

Calendar records retain the database term `branch_closure` for compatibility. In this runbook, a “branch closure” means an announced closure of the physical intake location selected in the active attestation; it does not refer to a provider branch ID. If the selected location is a drop spot or mail-in hub, record its announced closure under the same calendar kind.

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

The admin Operations workspace at `/admin/operations` is the primary exception queue. It orders payment risk, provider jobs/outcomes, shipment generations, address supplements, customer decisions, cases/claims/replacements/returns, refunds, manual fulfillment, funding, and calendar/tax/policy readiness by the next deadline. Every row exposes a stable record ID, state version, evidence summary, and conflict token. After any mutation or 409 response, refresh and re-review the current version before retrying. The Orders workspace remains the order-detail and label-purchase view.

Risk clearance and high-risk address approval require explicit Google step-up authentication. A step-up page identifies the action and target, starts a fresh Google authorization with `prompt=login` and `max_age=0`, and returns to the queue without executing the action. The operator must review the refreshed record and submit again. Never accept a browser-supplied timestamp or evidence-attestation boolean as proof.

`ready for staff` permits label purchase. Staff enters the actual packed weight and expected Chit Chats receipt date. Rates are refreshed before purchase. The customer-selected service is retained when available; otherwise the endpoint returns the current insured tracked alternatives and requires an audited reason.

`manual review` means the external outcome could not be determined safely. Do not retry buy/refund blindly. Search Chit Chats by the stored `public_reference` or provider shipment ID, reconcile the provider state, then update the local record through a controlled repair procedure. The policy worker alerts at two coverage hours, escalates at four, and preserves the original handoff and auto-refund deadlines.

The label endpoint fetches a fresh signed provider URL in memory and proxies a validated PDF. Signed label URLs must not be copied into logs or PostgreSQL.

The one-minute shipping cron polls purchase and tracking state and sends accepted, exception, and delivered emails. The 15-minute policy cron handles SLA/manual-review escalation, decision deadlines, remedies, returns, refunds, funding reviews, and policy reminders. Both accept `CHITCHATS_WORKER_CRON_SECRET` or the configured Vercel `CRON_SECRET`. Abandoned quote PII is redacted after 30 days. Shipping PII is redacted at the earlier of 180 days after all linked work is terminal or 365 days after order creation.

Application telemetry suppresses outbound signed-label requests and inbound token-bearing customer-link routes. Before launch, Operations must separately audit and purge staging traces or access logs containing signed label URLs or customer bearer query values, and verify Vercel plus every external drain applies equivalent query-value redaction. This external audit is a required launch gate because application instrumentation cannot control platform access logs already captured upstream.

Postage refund is separate from a Helcim customer refund. The postage action requests only Chit Chats credit. Customer remedies use `product_order_refunds` with local balance locking and a stable UUID idempotency key. An unknown Helcim outcome is reconciled and never resubmitted blindly.

## External evidence register

Before production enablement, attach dated evidence for:

- Chit Chats auto-reload values and dedicated-card issuer controls.
- The current owner-attested physical intake location, including its record ID, evidence reference, exact environment/client/region match, and expiration date.
- All active role assignments, physical-intake-location closures (stored as `branch_closure`), and service-policy review dates.
- Helcim sandbox full/partial refunds and ambiguous-outcome reconciliation.
- Database backup expiry of 30 days or less.
- Log, export, Resend, label-download, and support-artifact deletion settings that make PII unrecoverable by day 395.
- Observe-mode deadline comparison and the completed staging fault-injection matrix.

## Rollback

Use the narrowest independent flag for the failed surface:

- `CHITCHATS_CHECKOUT_ENABLED=false` stops new automated product quotes/checkouts.
- `CHITCHATS_US_SHIPPING_ENABLED=false` stops only new U.S. shipping admission.
- `SUPPLEMENTAL_PRODUCT_PAYMENTS_ENABLED=false` stops new address-increase/manual-shipping child payments.
- `MANUAL_PRODUCT_CHECKOUT_ENABLED=false` stops new manual pickup/manual-shipping checkout admission.
- `SHIPPING_POLICY_ENFORCEMENT_MODE=observe` stops policy-worker mutations while preserving evaluation and alert evidence; use only under the approved incident plan.

Leave `CHITCHATS_SHIPPING_ENABLED=true`, the worker cron route, provider/payment credentials, and customer notification processing deployed until every already-paid shipment, refund, supplement, decision, and case is terminal. Do not use a checkout admission rollback to strand existing work. Do not delete provider IDs, local history, quarantine evidence, or additive schema during application rollback.

For upgrades from migration 0033, the additive migrations quarantine duplicate legacy Helcim transaction identities, exclude the affected orders from automated fulfillment and uniqueness admission, and move them to payment risk review. Review every open `fulfillment_data_quarantine` row in `/admin/operations`; do not infer which duplicate owns the provider transaction or erase the retained evidence. CI exercises both a clean zero-to-latest database and a data-bearing 0033 upgrade containing duplicate legacy identities.
