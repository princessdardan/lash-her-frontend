import { redirect } from "next/navigation";
import { FRESHA_BOOKING_URL } from "@/lib/booking/fresha";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Deliberately ignore all query parameters, including private session references.
// This page-level redirect leaves payment and confirmation child routes intact.
export default function ServiceBookingEntryPage() {
  redirect(FRESHA_BOOKING_URL);
}
