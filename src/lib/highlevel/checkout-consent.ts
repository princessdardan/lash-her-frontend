import "server-only";
import { sql } from "drizzle-orm";
import {
  CONSENT_VERSION,
  EMAIL_CONSENT_TEXT,
  normalizeEmail,
  type CheckoutMarketing,
} from "./contract";
import { recordSmsChoice, type CrmDb } from "./store";

/** Called inside the order INSERT transaction; retries keep the original evidence. */
export async function recordCheckoutConsent(
  tx: CrmDb,
  input: {
    orderId: string;
    email: string;
    source: string;
    marketing?: CheckoutMarketing;
  },
): Promise<void> {
  if (!input.marketing) return;
  const now = new Date();
  await tx.execute(sql`insert into highlevel_consent_events (origin_key, email_normalized, channel, destination, choice, consent_text, consent_version, source, occurred_at)
    values (${`checkout:${input.orderId}:email`}, ${normalizeEmail(input.email)}, 'email', ${normalizeEmail(input.email)}, ${input.marketing.marketingConsent === true ? "opted_in" : "not_opted_in"}, ${EMAIL_CONSENT_TEXT}, ${CONSENT_VERSION}, ${input.source}, ${now}) on conflict do nothing`);
  await recordSmsChoice(tx, {
    email: input.email,
    phone: input.marketing.phone,
    optedIn: input.marketing.smsMarketingConsent,
    source: input.source,
    originKey: `checkout:${input.orderId}:sms`,
    occurredAt: now,
  });
}
