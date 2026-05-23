import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const schedulePageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("training schedule route contract", () => {
  it("disables static caching and indexing for token-bearing schedule links", () => {
    assert.match(schedulePageSource, /unstable_noStore as noStore/);
    assert.match(schedulePageSource, /export const revalidate = 0;/);
    assert.match(schedulePageSource, /export const dynamic = "force-dynamic";/);
    assert.match(schedulePageSource, /robots: \{ index: false, follow: false \}/);
    assert.match(schedulePageSource, /noStore\(\);/);
  });

  it("accepts only token in searchParams and rejects any other keys", () => {
    assert.match(schedulePageSource, /const resolvedSearchParams = await searchParams;/);
    assert.match(schedulePageSource, /const keys = Object\.keys\(resolvedSearchParams\);/);
    assert.match(schedulePageSource, /if \(keys\.length > 1 \|\| \(keys\.length === 1 && keys\[0\] !== "token"\)\) \{/);
    assert.match(schedulePageSource, /notFound\(\);/);
  });

  it("verifies token plus route slug server-side", () => {
    assert.match(schedulePageSource, /const eligibility = await resolveTrainingIntroCallEligibility\(/);
    assert.match(schedulePageSource, /programSlug: slug,/);
    assert.match(schedulePageSource, /schedulingToken: token,/);
  });

  it("renders route-specific quiet-luxury schedule shell", () => {
    assert.match(schedulePageSource, /<h1 className="section-heading mb-2">Schedule Training Call<\/h1>/);
    assert.match(schedulePageSource, /<h2 className="section-subheading">\{program\.title\}<\/h2>/);
  });

  it("renders Google Appointment Schedule after paid token eligibility without app-owned slot picker", () => {
    assert.match(schedulePageSource, /const eligibility = await resolveTrainingIntroCallEligibility\(/);
    assert.match(schedulePageSource, /const appointmentScheduleUrl = getGoogleAppointmentScheduleUrl\(program\.introCallAppointmentScheduleUrl\);/);
    assert.match(schedulePageSource, /<AppointmentScheduleCard/);
    assert.match(schedulePageSource, /Open Google Appointment Schedule/);
    assert.match(schedulePageSource, /<iframe\s+src=\{scheduleUrl\}/);
    assert.doesNotMatch(schedulePageSource, /BookingFlow/);
    assert.doesNotMatch(schedulePageSource, /paidSchedulingToken=\{token\}/);
    assert.doesNotMatch(schedulePageSource, /paidTrainingSlug=\{slug\}/);
  });

  it("rejects invalid or missing schedule config without exposing the Appointment Schedule URL", () => {
    assert.match(schedulePageSource, /if \(!eligibility\.ok\) \{/);
    assert.match(schedulePageSource, /return <SafeErrorShell programTitle=\{program\.title\} \/>;/);
    assert.match(schedulePageSource, /if \(!appointmentScheduleUrl\) \{/);
    assert.match(schedulePageSource, /function getGoogleAppointmentScheduleUrl/);
    assert.match(schedulePageSource, /url\.hostname === "calendar\.google\.com"/);
    assert.match(schedulePageSource, /url\.pathname\.startsWith\("\/calendar\/appointments\/schedules\/"\)/);
  });

  it("renders a branded safe error with support/contact CTA and no private details for token failures", () => {
    assert.match(schedulePageSource, /if \(!token\) \{/);
    assert.match(schedulePageSource, /return <SafeErrorShell programTitle=\{program\.title\} \/>;/);
    assert.match(schedulePageSource, /function SafeErrorShell\(\{ programTitle \}: \{ programTitle: string \}\) \{/);
    assert.match(schedulePageSource, /<h1 className="section-heading mb-2">Scheduling Unavailable<\/h1>/);
    assert.match(schedulePageSource, /We could not verify this training scheduling link\. It may be invalid, expired, or already used\./);
    assert.match(schedulePageSource, /<Link\s+href="\/contact"\s+className="btn-primary-red inline-block"\s*>/);
    assert.doesNotMatch(schedulePageSource, /orderId/);
    assert.doesNotMatch(schedulePageSource, /checkoutEmail/);
  });
});
