import assert from "node:assert/strict";
import test from "node:test";
import BookingPage from "./page";
import ServiceBookingPage from "../services/[slug]/booking/page";
import { FRESHA_BOOKING_URL } from "@/lib/booking/fresha";

test("both booking entry pages throw only a temporary redirect to the fixed Fresha URL", () => {
  for (const page of [BookingPage, ServiceBookingPage]) {
    assert.throws(
      () => page(),
      (error: unknown) => {
        assert.equal(
          (error as { digest: string }).digest,
          `NEXT_REDIRECT;replace;${FRESHA_BOOKING_URL};307;`,
        );
        return true;
      },
    );
  }
});
