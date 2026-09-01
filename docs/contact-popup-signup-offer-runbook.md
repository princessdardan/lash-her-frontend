# Contact Popup Signup Offer Runbook

## Contract

- Global Settings may enable one published promotion for the contact-popup welcome email.
- The selected promotion must be enabled and have `appliesTo: "all"`.
- Editors provide the offer label, terms, CTA label, and HTTPS CTA URL alongside the promotion reference.
- A normalized email address receives the offer at most once for each selected promotion. Selecting a different promotion permits one offer for that new promotion.
- Disabled or invalid offer configuration, and a repeat signup for the same promotion, sends the existing generic welcome email.
- An admin-notification failure does not fail the signup or customer-email flow.

## Request and delivery flow

1. The server reads one fresh, published Sanity snapshot containing Global Settings and the referenced promotion. It validates the reference, promotion revision, unique normalized code, `appliesTo`, value, and editor-authored copy.
2. The contact-popup submission, consent event, marketing-sync job, and offer-email outbox row are written in one PostgreSQL transaction. If any required write fails, none of those writes commit.
3. A keyed, environment- and dataset-scoped digest of the normalized email plus promotion ID is the unique delivery key. It enforces once-per-email-per-promotion without placing the email address in the key. The database transaction checks the current and every retained key under the same normalized-email advisory lock before inserting.
4. The request targets the newly created outbox row for an immediate delivery attempt. Provider failure does not discard the signup: the customer-email cron worker retries the durable row with the same provider idempotency key.
5. Admin notification is attempted separately and is nonblocking.

The public form-action response does not contain the offer status, promotion, discount code, outbox ID, or provider result. The code exists only in the private encrypted outbox payload and the customer email.

## Unsubscribe behavior

Offer emails contain a signed, encrypted, audience-scoped unsubscribe URL. The email address is not readable from the opaque token.

- `GET /api/marketing/unsubscribe?token=...` validates the token and displays a confirmation page without changing subscription state.
- `POST /api/marketing/unsubscribe?token=...` performs the unsubscribe. The same URL is also supplied through `List-Unsubscribe` and `List-Unsubscribe-Post` for one-click POST requests from supporting mail clients.
- The PostgreSQL transaction records the unsubscribe, prevents pending opt-in sync from re-subscribing the contact, and dead-letters and redacts unsent popup-offer rows for that normalized email.
- An internal unsubscribe durably enqueues a Resend suppression-sync job. A Resend-originated unsubscribe webhook updates PostgreSQL but does not enqueue a return sync, avoiding a provider feedback loop.
- Replaying the same link reasserts suppression but reuses the current consent generation's unsubscribe event and provider-sync job. An explicit later opt-in opens a new generation that can be unsubscribed again.
- After a Resend opt-in sync, the worker rechecks authoritative PostgreSQL consent. If an unsubscribe committed while the provider request was in flight, the worker immediately sends a compensating Resend unsubscribe and retains retry semantics on failure.
- The email worker checks current subscription state immediately before calling Resend. A residual race remains: an unsubscribe that commits after that check while the provider request is already in progress cannot recall that send. Later attempts are suppressed.

## Retention and redaction

The outbox stores the recipient and offer snapshot encrypted. A normalized recipient is retained only while the offer row is active so database integrity and unsubscribe suppression can be enforced.

Outbox PII is due for redaction no later than the earlier of:

- 365 days after the outbox row is created; or
- 395 days after the linked contact-popup submission.

The retention job clears the encrypted recipient, normalized recipient, encrypted template data, and retained error details. Unsubscribe handling immediately redacts any unsent matching offer rows. Database constraints require each active offer row to link to an opted-in contact-popup submission with the same normalized recipient.

## Rollout

Perform the rollout in this order.

### 1. Apply the private-database migration

Verify the target and committed migration lineage before and after migration:

```sh
npm run db:check -- --env-file .env.production
```

Apply migrations only after backup/PITR and change approval. The migrator requires the exact database host and target. Production also requires the explicit production confirmation:

```sh
PRIVATE_DB_MIGRATION_TARGET=production \
PRIVATE_DB_MIGRATION_HOST=<verified-database-host> \
PRIVATE_DB_MIGRATION_CONFIRM=production \
npm run db:migrate
```

Use `PRIVATE_DB_MIGRATION_TARGET=local` or `staging` for those environments and omit the production confirmation. `npm run db:check` is read-only; `npm run db:migrate` writes and enforces migration lineage and target guards.

Migration `0076` creates a unique outbox index and validates a new check constraint. Both operations can briefly block writes while PostgreSQL scans the table. Check the production `customer_email_outbox` row count and schedule an approved maintenance window if the table is nontrivial; do not apply this migration during an unreviewed traffic window.

### 2. Deploy the application code and configure the keyrings

Deploy application code only after the database accepts the new outbox shape. Deploy the schema to the intended dataset:

```sh
NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 npx sanity schema deploy
```

Production schema deployment has an additional guard:

```sh
SANITY_SCHEMA_DEPLOY_TARGET=production \
NEXT_PUBLIC_SANITY_DATASET=production \
npx sanity schema deploy
```

This runbook addition does not apply a database migration or deploy a Sanity schema. Those remain explicit environment operations.

The signup-offer dedupe key has a separate, long-lived server-only contract:

- `CONTACT_POPUP_OFFER_DEDUPE_CURRENT_KEY=<version>:<base64-encoded 32-byte key>` is the key used for new grants. Version names must never be reused with different key bytes.
- `CONTACT_POPUP_OFFER_DEDUPE_PREVIOUS_KEYS=<version>:<key>,...` contains every retained dedicated key. Retained entries are checked but are not used for new grants.
- `CONTACT_POPUP_OFFER_DEDUPE_LEGACY_CHECKOUT_KEYS=<key>,...` contains outgoing `CHECKOUT_SECRET_ENCRYPTION_KEY` values needed to recognize rows created by the original checkout-derived scheme.

When `CONTACT_POPUP_OFFER_DEDUPE_CURRENT_KEY` is absent, the runtime preserves the original `CHECKOUT_SECRET_ENCRYPTION_KEY` derivation exactly. This compatibility fallback lets the keyring-aware code deploy without changing current local or deployed configuration. New deployments should configure a distinct dedicated current key; do not reuse checkout, encryption, signing, or webhook secrets.

Rotate without a mixed-runtime gap:

1. Add the next dedicated `version:key` to `CONTACT_POPUP_OFFER_DEDUPE_PREVIOUS_KEYS` while leaving the old current key unchanged, deploy, and drain instances that do not know the next key.
2. Promote that entry to `CONTACT_POPUP_OFFER_DEDUPE_CURRENT_KEY`, move the outgoing current entry into `CONTACT_POPUP_OFFER_DEDUPE_PREVIOUS_KEYS`, deploy, and drain the preceding deployment.
3. Before rotating `CHECKOUT_SECRET_ENCRYPTION_KEY`, add its outgoing value to `CONTACT_POPUP_OFFER_DEDUPE_LEGACY_CHECKOUT_KEYS` and deploy that candidate set first.

Retain keys for as long as any `customer_email_outbox` row derived from them remains. Removing a retained key earlier weakens the once-per-email-per-promotion guarantee for that historical key version. The stored provider idempotency key on an existing row never changes, so retries continue to use the original provider key after rotation.

Configure the separate unsubscribe-token keyring before enabling the offer:

- `MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID=<key-id>` names the key used for new tokens.
- `MARKETING_UNSUBSCRIBE_KEYS=<key-id>:<base64-encoded 32-byte key>,...` contains the current key and every retained verification key.

Both unsubscribe variables must be present together. New tokens embed the key ID; retained keys continue to verify earlier tokens. Existing `v1` tokens remain compatible through `CHECKOUT_SECRET_ENCRYPTION_KEY`. With both dedicated variables absent, the runtime issues legacy `v1` tokens for compatibility, but new deployments should use the dedicated keyring. Because unsubscribe links intentionally do not expire, never remove a retained unsubscribe key while a link issued under it may still be used, and preserve the checkout key needed by any legacy `v1` links.

### 3. Update and publish the active Resend template

With the configured local Resend credentials and the exact active `contact_popup_customer` template ID:

```sh
npm run resend:update-contact-popup-template -- --apply
```

The command verifies the configured template identity, updates it, publishes it, and verifies the published result. The active Resend template was updated, published, and postflight-verified on 2026-08-31.

### 4. Configure and publish Global Settings

Keep the offer disabled while editing. Select an enabled promotion whose `appliesTo` value is `all`, enter the label, terms, CTA label, and HTTPS CTA URL, then enable and publish Global Settings. The runtime fails closed to the generic welcome email if the enabled configuration cannot be validated.

### 5. Smoke test

Verify in the target environment:

- Disabled configuration sends the generic welcome.
- An invalid enabled configuration sends the generic welcome and records no offer job.
- A first signup sends the selected offer and creates one durable outbox row.
- Repeating the normalized email with the same promotion sends the generic welcome and does not create another offer row.
- Selecting a different valid promotion permits one new offer.
- The public response exposes no discount or delivery details.
- A provider failure leaves a retryable outbox row, and the cron worker later delivers it once.
- Admin-email failure does not change the successful customer flow.
- Browser `GET` shows unsubscribe confirmation; form `POST` unsubscribes; a one-click POST also succeeds; later queued offer delivery is suppressed and Resend suppression sync is queued.
- Retention processing redacts due offer payload and recipient fields.

## Rollback

1. Disable the signup-offer flag in Global Settings and publish it first. New signups immediately return to the generic welcome path; the updated customer template remains compatible because its offer block may be empty.
2. Disabling the flag is not retroactive. Existing queued offer snapshots can still retry. If they must not send, pause the customer-email worker and use an operator-reviewed suppression/redaction procedure before resuming it.
3. Restore application or template revisions only after new offer writes have stopped and queued rows are delivered or suppressed. The additive database migration and Sanity fields can remain in place during rollback.
