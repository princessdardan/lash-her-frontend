import Link from "next/link";
import type { BookingType } from "@/lib/booking/types";

interface BookingEntryLinkProps {
  bookingType?: BookingType;
  children: React.ReactNode;
  className?: string;
}

export function BookingEntryLink({ bookingType, children, className }: BookingEntryLinkProps) {
  const href = bookingType ? `/booking?type=${bookingType}` : "/booking";
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
