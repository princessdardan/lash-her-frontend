# Chit Chats shipping operations

## Scope

The integration supports one parcel per product order to Canada and, behind a separate gate, the United States. Customers choose a live Chit Chats rate that includes full tracking and confirmed insurance. Helcim charges discounted merchandise plus the complete Chit Chats `payment_amount`. Staff confirms measured weight and ship date before buying postage. Lash Her absorbs quote-to-purchase variance.

It does not implement split shipments, partial fulfillment, batch labels, customer returns, signature services, or supplemental customer charges/refunds for postage variance.

## Rollout gates

1. Apply the private database migration.
2. Review the seeded `small-mailer`, `medium-parcel`, and `large-parcel` profiles in `shipping_package_profiles`. Change dimensions, tare weight, capacity, and maximum weight to match physical packaging before quoting.
3. Deploy the Sanity schema to staging.
4. Populate every purchasable product and variant with fulfillment mode, item weight, packing units, customs description, and country of origin. A variant shipping object is a complete override; partial overrides are not merged.
5. Dry-run and apply the product confirmation template update with `npm run resend:seed-templates` and `npm run resend:seed-templates -- --apply` so shipping and merchandise totals are both rendered.
6. Configure a Chit Chats staging account, return address, branch, label format, account credits, and API token.
7. Set the Chit Chats server-only environment variables with `CHITCHATS_SHIPPING_ENABLED=true`, `CHITCHATS_CHECKOUT_ENABLED=true`, and `CHITCHATS_US_SHIPPING_ENABLED=false`.
8. Exercise the staging matrix below before enabling Canada in production.
9. Keep U.S. shipping disabled until Chit Chats confirms the current DDP request contract for the account and every U.S.-approved SKU has a 10-digit HTS code and complete manufacturer address.

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

`manual review` means the external outcome could not be determined safely. Do not retry buy/refund blindly. Search Chit Chats by the stored `public_reference` or provider shipment ID, reconcile the provider state, then update the local record through a controlled repair procedure.

The label endpoint fetches a fresh signed provider URL in memory and proxies a validated PDF. Signed label URLs must not be copied into logs or PostgreSQL.

The shipping cron polls purchase and tracking state and sends accepted, exception, and delivered emails. It accepts `CHITCHATS_WORKER_CRON_SECRET` or the configured Vercel `CRON_SECRET`. Abandoned quote PII is redacted after 30 days. Order-linked shipment PII is redacted after the checkout retention job has redacted the order and shipment is terminal.

Postage refund is separate from a Helcim customer refund. The admin action requests only the Chit Chats postage refund, which may remain pending for up to two weeks.

## Rollback

Set `CHITCHATS_CHECKOUT_ENABLED=false` to stop new quotes and product checkouts that depend on shipping. Leave `CHITCHATS_SHIPPING_ENABLED=true`, the cron route, and credentials deployed until all purchased/accepted shipments are terminal so tracking and customer notifications continue. Do not delete provider shipment IDs or local shipment history during rollback.
