// Manual, egress-blocked browser audit of the unmodified downloaded vendor script.
// node scripts/highlevel-tracking-probe.mjs /absolute/path/external-tracking.js
// This is a client-behavior probe, not proof of HighLevel backend behavior.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const source = await readFile(process.argv[2], "utf8");
const scriptUrl = "https://link.msgsndr.com/js/external-tracking.js";
const origin = "http://127.0.0.1:3139";
const trackingId = "tk_lashher_isolated_probe";
const events = [];
const destinations = new Set();
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.url() === scriptUrl) {
      await route.fulfill({
        contentType: "application/javascript",
        body: source,
      });
    } else if (url.origin === origin && request.isNavigationRequest()) {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Isolated tracking probe</title><h1>Probe</h1>",
      });
    } else {
      // No event or other request reaches HighLevel or any third party.
      destinations.add(request.url());
      if (request.postData()) {
        try {
          events.push(JSON.parse(request.postData()));
        } catch {
          /* not JSON */
        }
      }
      await route.abort("blockedbyclient");
    }
  });
  const page = await context.newPage();
  await page.goto(`${origin}/?token=SYNTHETIC_QUERY_CANARY#SYNTHETIC_FRAGMENT`);
  const before = await page.evaluate(() => ({
    cookies: document.cookie,
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }));
  await page.evaluate(
    ({ scriptUrl, trackingId }) => {
      document.querySelectorAll("script").forEach((s) => s.remove());
      const script = document.createElement("script");
      script.src = scriptUrl;
      script.dataset.trackingId = trackingId;
      document.body.append(script);
    },
    { scriptUrl, trackingId },
  );
  await page.waitForFunction(() => window._lcTracking?.timeTracker);
  const after = await page.evaluate(() => ({
    cookies: document.cookie,
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    trackerMethods: Object.getOwnPropertyNames(
      Object.getPrototypeOf(window._lcTracking.tracker),
    ),
  }));
  const views = () =>
    events.filter((e) => e.type === "external_script_page_view").length;
  const initialViews = views();
  await page.evaluate(() => {
    history.pushState({}, "", "/gallery");
    history.replaceState({}, "", "/products");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForTimeout(450);
  const afterNavigationViews = views();
  await page.evaluate(() => {
    document.querySelectorAll("script").forEach((s) => s.remove());
    const form = document.createElement("form");
    form.id = "synthetic-excluded-form";
    form.innerHTML =
      '<input name="email" type="email" value="synthetic@example.invalid"><textarea name="intakeNotes">SYNTHETIC_INTAKE_CANARY</textarea><input name="password" type="password" value="SYNTHETIC_PASSWORD_CANARY"><button type="submit">Submit</button>';
    form.addEventListener("submit", (e) => e.preventDefault());
    document.body.append(form);
  });
  await page.waitForTimeout(100);
  await page.locator("form").evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(250);
  const formEvent = events.find((e) => e.type === "external_form_submission");
  await page.reload();
  await page.waitForTimeout(450);
  const unloadEvents = events.filter(
    (e) => e.type === "external_page_time_spent",
  );
  const initialEvent = events.find(
    (e) => e.type === "external_script_page_view",
  );
  assert.equal(before.cookies, "");
  assert.equal(initialViews, 1);
  assert.equal(afterNavigationViews, initialViews);
  assert.match(after.cookies, /lc_session_tk_lashher_isolated_probe=/);
  assert.equal(formEvent?.formData?.intakeNotes, "SYNTHETIC_INTAKE_CANARY");
  assert.equal(formEvent?.formData?.password, undefined);
  assert.ok(unloadEvents.length >= 1);
  assert.ok(initialEvent?.url?.includes("SYNTHETIC_QUERY_CANARY"));
  assert.ok(initialEvent?.url?.includes("SYNTHETIC_FRAGMENT"));
  console.log(
    JSON.stringify(
      {
        sourceSha256: createHash("sha256").update(source).digest("hex"),
        isolation:
          "Synthetic tracking ID; all outbound requests intercepted and aborted; no vendor ingestion/contact writes tested",
        before,
        after,
        initialViews,
        afterNavigationViews,
        formCaptureAfterScriptRemoval: !!formEvent,
        formFieldNames: Object.keys(formEvent?.formData ?? {}),
        fullQueryAndFragmentInPageView: true,
        unloadEventsAfterScriptRemoval: unloadEvents.length,
        attemptedDestinations: [...destinations],
        observedEventTypes: [...new Set(events.map((e) => e.type))],
        identityAssociation:
          "Not tested; no designated contact or isolated location supplied",
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
