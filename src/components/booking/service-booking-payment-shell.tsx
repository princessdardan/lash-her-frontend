"use client";

import type { ServiceBookingPaymentSessionDisplay } from "@/lib/booking/payment-session";

export function ServiceBookingPaymentShell({
  session,
}: {
  session: ServiceBookingPaymentSessionDisplay;
}) {
  return <div>{session.serviceTitle}</div>;
}
