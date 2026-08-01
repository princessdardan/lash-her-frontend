import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveAdminAppointmentDateBasis } from "./appointment-filter-policy";

const appointmentReadSource = readFileSync(
  new URL("./appointment-read.ts", import.meta.url),
  "utf8",
);
const appointmentsPageSource = readFileSync(
  new URL("../../app/admin/(protected)/appointments/page.tsx", import.meta.url),
  "utf8",
);
const dashboardPageSource = readFileSync(
  new URL("../../app/admin/(protected)/page.tsx", import.meta.url),
  "utf8",
);
const reportsPageSource = readFileSync(
  new URL("../../app/admin/(protected)/analytics/page.tsx", import.meta.url),
  "utf8",
);

test("completion date basis is accepted only for completed appointments", () => {
  assert.equal(
    resolveAdminAppointmentDateBasis({
      basis: "completed",
      status: "completed",
    }),
    "completed",
  );
  assert.equal(
    resolveAdminAppointmentDateBasis({
      basis: "completed",
      status: "confirmed",
    }),
    "scheduled",
  );
  assert.equal(
    resolveAdminAppointmentDateBasis({
      basis: "completed",
      status: "",
    }),
    "scheduled",
  );
});

test("unknown and absent date bases retain scheduled-date behavior", () => {
  assert.equal(
    resolveAdminAppointmentDateBasis({
      basis: "",
      status: "completed",
    }),
    "scheduled",
  );
  assert.equal(
    resolveAdminAppointmentDateBasis({
      basis: "paid",
      status: "completed",
    }),
    "scheduled",
  );
});

test("completion drill-down applies exclusive business-date bounds to completedAt", () => {
  assert.match(
    appointmentReadSource,
    /gte\(appointments\.completedAt, range\.start\)/,
  );
  assert.match(
    appointmentReadSource,
    /lt\(appointments\.completedAt, range\.endExclusive\)/,
  );
});

test("completion date basis survives forms and generated appointment URLs", () => {
  assert.match(
    appointmentsPageSource,
    /name="basis" type="hidden" value="completed"/,
  );
  assert.match(
    appointmentsPageSource,
    /basis:\s*filters\.dateBasis === "completed"/,
  );
  assert.match(
    appointmentsPageSource,
    /Date filters use the appointment completion date\./,
  );
});

test("dashboard and report completion metrics use the exact completion drill-down", () => {
  const drillDown =
    /\/admin\/appointments\?view=all&status=completed&basis=completed/;
  assert.match(dashboardPageSource, drillDown);
  assert.match(reportsPageSource, drillDown);
});
