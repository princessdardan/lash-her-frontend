import assert from "node:assert/strict";
import test from "node:test";

import { createBookingCreatePostHandler } from "./route";

function createRequest(body: string) {
  return new Request("http://localhost:3000/api/booking/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("booking create rejects invalid JSON", async () => {
  const handler = createBookingCreatePostHandler();
  const response = await handler(createRequest("{bad-json"));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    success: false,
    error: "Invalid booking request",
  });
});

test("booking create rejects all direct calendar booking requests", async () => {
  const handler = createBookingCreatePostHandler();
  const response = await handler(createRequest(JSON.stringify({
    bookingType: "in-person-appointment",
    serviceSlug: "classic-fill",
    start: "2026-06-01T14:00:00.000Z",
  })));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    success: false,
    error: "Appointments require secure payment before Calendar confirmation.",
  });
});
