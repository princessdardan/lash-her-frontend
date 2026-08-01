import "server-only";

import { eq } from "drizzle-orm";

import {
  DEFAULT_BOOKING_MARKETING_OPT_IN_LABEL,
  normalizeBookingMarketingOptInLabel,
  normalizeOperationalBookingQuestions,
  type OperationalBookingUiSettings,
} from "@/lib/booking/operational-ui-settings";

import { getPrivateDb } from "./client";
import { bookingBusinessSettings } from "./schema";

export async function loadOperationalBookingUiSettings(
  db: ReturnType<typeof getPrivateDb> = getPrivateDb(),
): Promise<OperationalBookingUiSettings> {
  const [row] = await db
    .select({
      intakeQuestions: bookingBusinessSettings.intakeQuestions,
      marketingOptInLabel: bookingBusinessSettings.marketingOptInLabel,
      timezone: bookingBusinessSettings.timezone,
    })
    .from(bookingBusinessSettings)
    .where(eq(bookingBusinessSettings.singletonKey, "default"))
    .limit(1);

  if (!row) {
    return {
      intakeQuestions: [],
      marketingOptInLabel: DEFAULT_BOOKING_MARKETING_OPT_IN_LABEL,
      timezone: "America/Toronto",
    };
  }

  assertTimezone(row.timezone);

  return {
    intakeQuestions: normalizeOperationalBookingQuestions(row.intakeQuestions),
    marketingOptInLabel: normalizeBookingMarketingOptInLabel(
      row.marketingOptInLabel,
    ),
    timezone: row.timezone,
  };
}

function assertTimezone(value: string): void {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(new Date());
  } catch {
    throw new Error("Operational booking timezone is invalid");
  }
}
