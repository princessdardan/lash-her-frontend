import { FRESHA_BOOKING_URL } from "@/lib/booking/fresha";
import Link from "next/link";
import type { BookingType } from "@/lib/booking/types";

interface BookingEntryLinkProps {
  bookingType?: BookingType;
  children: React.ReactNode;
  className?: string;
}

export function BookingEntryLink({
  bookingType,
  children,
  className,
}: BookingEntryLinkProps) {
  void bookingType;
  const href = FRESHA_BOOKING_URL;
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
