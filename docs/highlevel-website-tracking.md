# HighLevel website tracking — 2026-10-20

## Release decision

**Blocked; no embed is installed.** This change implements independent browser
preferences and a fail-closed release gate. It does not implement active browsing,
attribution, or browser-to-contact association. Setting
`HIGHLEVEL_TRACKING_ENABLED=true` alone cannot enable the tracker.

The account settings provide form-related switches, but safe client-side exclusion,
withdrawal without outgoing unload traffic, and association with API-created contacts
have not been established. The user confirmed that no isolated test location or
designated test contact exists. No production tracking requests, contacts, workflows,
or marketing messages were created by this audit.

## Evidence and capability boundaries

Official references reviewed on 2026-10-20:

- [External form tracking](https://help.gohighlevel.com/support/solutions/articles/155000006092)
  documents automatic DOM-form detection, contact creation/update, page/session
  attribution, and email-based form matching. It describes an account-specific
  script and `data-tracking-id`.
- [External tracking analytics](https://help.gohighlevel.com/support/solutions/articles/155000007809-analytics-for-external-tracking)
  describes page/form metrics and device, browser, IP and geography reporting.

The account's Troubleshoot panel also links to the official
[LeadConnector form-tracking guide](https://help.leadconnectorhq.com/support/solutions/articles/155000006093-track-external-forms-with-the-tracking-script).
That guide describes the same automatic form-to-CRM path. The UI recommends
named, enabled DOM fields and native form submission for matching; it supplies
no browsing-only identification or consent lifecycle instructions.

None of the three reviewed articles specifies a public identify API for server-created
contacts, manual SPA page-view API, consent API, complete teardown, or reset API.
Absence from these references is not proof that HighLevel offers no such capability;
obtain an applicable supported contract before implementing one.

### Account UI observations

Inspected the authenticated **Lash Her By Nataliea** production location
`vd09FLBpPLXuHb5Tnhn4` at
[Settings → External Tracking](https://app.gohighlevel.com/v2/location/vd09FLBpPLXuHb5Tnhn4/settings/external-tracking).
The connector's authorized external-tracking operation search returned no available
operation. The browser supplied the following public embed configuration:

```html
<script src="https://link.msgsndr.com/js/external-tracking.js"
        data-tracking-id="tk_6cc832e4dc314d03a1f0e169446d108c"></script>
```

This is evidence, **not installation instructions for this release**. The tracking
ID is public and separate from runtime OAuth/client secrets. It must never be used
for development or preview tests.

Settings showed three enabled switches: **Page View Analytics**, **Form Analytics**,
and **Form Submissions**. The UI distinguishes interaction analytics from CRM writes;
submission writes depend on field mapping. These are account settings, not a verified
per-visitor exclusion mechanism. All production settings were left unchanged. Their
server-side behavior with switches disabled was not tested.

### Real script: source inspection and isolated Chromium observations

Fetched the public script without executing it in production. Audited SHA-256:
`efe60b58f9f60b0a78a3b080523350a64db4b9c506b3849b6bcad4aa29331115`.
The URL is mutable; this result applies to these bytes only.

The [probe output](highlevel-website-tracking-client-probe-2026-10-20.json) records
execution of those **unmodified vendor bytes** in a fresh Chromium context. An
intercepted script response supplied the downloaded bytes at the normal embed URL.
It used a synthetic tracking ID and synthetic form values; all other outbound HTTP
requests were recorded and aborted before delivery. This proves browser collection
and attempted requests. It does **not** prove ingestion, CRM effects, identity
linking, settings enforcement, or dashboard results in a real location.

| Capability | Observed or inspected | Consequence |
| --- | --- | --- |
| Session identifier | Source sets `lc_session_<tracking-id>` at `/`, SameSite Lax, one-day expiry; probe observed it immediately after initialization. Source uses sessionStorage under the same key if cookies fail. | No initialization before consent. Cookie fallback was inspected, not browser-tested. |
| Other browser data | Source reads localStorage `_ud`, including contact/user IDs and a `customer_id` alias. Fresh probe created no localStorage/sessionStorage keys. | This compatibility reader is not a supported identification contract. The site never writes `_ud`; shared ownership is unproven, so no blanket deletion is implemented. |
| Event destination | Probe attempted POSTs to `https://backend.leadconnectorhq.com/external-tracking/events`; no settings fetch was observed. | Form-related server switches alone cannot establish that excluded input data never leaves a browser. |
| Event data | Source includes tracking/session IDs, timestamp, page title, full URL/path, referrer, user agent and device type; optional known IDs are read from `_ud`. Probe observed query and fragment canaries in a page-view body. | Sanitizing a separate URL object does not constrain the embed's own raw URL reads. |
| Forms | Source attaches submit/click handlers and a MutationObserver. Probe captured a dynamically added form after script removal, including synthetic email, intake text and timezone; a password field was excluded. Source also supports file uploads. | Vendor heuristics are insufficient to protect unrelated fields, payment/intake flows, or PostgreSQL-first persistence. There is no approved second submission path. |
| Navigation | Probe observed exactly one initial page view and no additional view after pushState, replaceState and a popstate event. | Automatic SPA tracking is not established. Internal methods are not a supported manual API; do not call or wrap them to force page views. |
| Removal/reload | Probe observed a time-spent POST on actual reload after removing the script. Source installs capture-phase unload/pagehide handlers and an activity timer. | Removing a tag and reloading is unsafe as a withdrawal strategy for these bytes. Persisting rejection first does not stop the old document's unload handler. |
| Teardown | Source exposes an internal time-tracker destroy method, but the tracker has no complete teardown covering form listeners/observers, queue retries and pending initialization. | No internal-method workaround, global network monkey patch, or guessed SDK method is shipped. |
| Identity | Documentation describes matching through captured forms. Neither account settings nor the probe establishes browser association for a contact created by the server API. | No hidden forms, fabricated submissions, email/contact query parameters, or `_ud` writes. |

IP/geography behavior is documented reporting behavior; the probe did not transmit
requests or measure backend IP handling. Referrer handling and identity were source
inspection only, not live contact-linking tests.

## Implemented site behavior

- `lh_cookie_consent` is version 2 with `required`, `analytics`, `crmTracking`, and
  the choice timestamp. Both optional choices default false. Valid version-1 values
  migrate with their analytics value and original timestamp preserved and CRM false.
  Unknown/malformed versions fail closed. Migration does not create consent evidence
  in PostgreSQL or invoke a marketing endpoint.
- Visitors can save and independently change either preference using **Manage cookie
  preferences** at the bottom of every public site page. Same-tab events, real storage
  events across tabs, reloads and pageshow restoration refresh subscribers. Unavailable
  storage uses an explicit in-tab choice and a visible persistence warning.
- The HighLevel preference can be saved, but the UI discloses that tracking is disabled.
  Consent cannot override `highLevelTrackingStatus()`'s code-level block. No script
  loader, SDK stub, tracking endpoint, identity bridge, or identifier cleanup is
  installed. There are no HighLevel listeners/timers/beacons to tear down on withdrawal,
  no browser IDs to reset, and no navigation events to deduplicate in this release.
- Vercel analytics remains independently controlled by `analytics`; the new shared
  store fixes consent refresh and restricted-storage handling. Its existing cleanup
  behavior is retained. This audit does not establish Vercel SDK teardown guarantees.
- Required storage, server submissions, the PostgreSQL outbox, suppression handling,
  email/SMS channel evidence, provider ownership and Resend delivery remain separate.
  Tracking choices make no server action or network request to grant/withdraw marketing.
- Cookie and privacy policy rendering includes an explicit disclosure of this actual
  disabled behavior. No Sanity content was edited.

The candidate URL policy admits only exact public collection routes `/`, `/gallery`,
`/services`, `/products`, and `/training-programs` on HTTPS lashher.com/www.lashher.com.
It rejects every query, fragment, credential, arbitrary slug and unknown route.
Admin, Studio, API/auth, checkout, payment/confirmation, course/access links, contact
forms, scheduling and policy pages are excluded. **This is groundwork for a future
loader, not an active navigation guard.** Nothing loads on any route today. Adding
attribution or dynamic CMS paths requires review rather than loosening the default.

The current Next configuration has baseline security headers but no enforced CSP.
This change does not broaden any script/connect policy or interfere with Square,
Studio, or course access.

## Verification and reproduction

```sh
DATABASE_URL= NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84 \
NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 \
node --import ./scripts/register-server-only-test.mjs --import tsx --test \
  src/lib/cookie-consent.test.ts src/lib/cookie-consent-store.test.ts \
  src/lib/highlevel/tracking-policy.test.ts \
  src/lib/highlevel/highlevel.test.ts src/lib/courses/signup.test.ts \
  src/lib/contact-popup/contact-popup-submission.test.ts \
  src/lib/marketing-contact/marketing-contact-store.test.ts
npx playwright test --config tests/tracking-consent.playwright.config.ts
# Download only the official public script, review/hash it, then run the lab:
node scripts/highlevel-tracking-probe.mjs /absolute/path/external-tracking.js
```

CI invokes its dedicated configuration after verifying the ordinary browser report.
The suite skips in the general Playwright configuration because its editorial/course
fixtures and disabled database are required; its output uses a separate directory.

The browser suite uses isolated editorial fixtures and a disabled DB. Its flag is
intentionally true while the code gate remains blocked. It checks absent/rejected,
granted, withdrawn, persisted and migrated preferences; cross-tab changes and clearing;
initial/client/Back/Forward navigation; sensitive URLs; blocked tracker transport;
form state and independent marketing choices; checkout/course rendering; and no
tracker requests/IDs. These are site-boundary tests, not vendor delivery tests.

Executed results:

- Assembled PR branch: full `npm run test:unit` passed **1,987 tests** with DB access disabled.

- Focused consent/store/policy, CRM, course-signup, popup and marketing-contact unit
  suites: **50 passed**, with operational DB access disabled.
- Desktop and mobile Chromium: **18 passed** using the isolated config. These include
  real cross-tab storage events and actual Next.js/Back/Forward navigation. No tracker
  requests, tracker IDs, server actions or operational API writes were observed.
- Targeted ESLint, TypeScript (`tsc --noEmit --incremental false`) and diff whitespace
  checks: passed.
- Real vendor-script probe: passed its observation assertions; one initial view,
  no added history-navigation view, dynamic-form capture after tag removal, full
  query/fragment data and one reload-time event attempt. All vendor events were
  intercepted and aborted; no ingestion or contact association was tested.

Commands ran on Node **26.5.0**; the repository targets Node 24. Full production build,
DB-dependent integration suites, live CRM effects and production smoke checks were
not run for this blocked tracking change. Course and checkout browser checks establish
rendering/form isolation, not completed purchases or newly persisted course grants.

## Activation requirements and rollback

1. Obtain an isolated HighLevel location, its own public embed ID/configuration, and
   designated test contacts. Keep production identifiers and OAuth secrets out of
   development/preview configuration. Do not reuse production CRM entity mappings.
2. Obtain supported client-side form-capture controls, then prove excluded fields are
   absent from **all outgoing requests**, including failed/invalid submissions,
   dynamic forms, popup fields, checkouts and course forms. Server suppression of CRM
   writes alone is insufficient. Prove no duplicate contact writes or workflow effects.
3. Obtain and test supported contact association for server-created contacts without
   captured/hidden forms or identity-bearing URLs. Test consent, suppression and
   identity changes with the designated contacts.
4. Obtain a complete supported stop/reset contract, or prove a withdrawal strategy
   that persists rejection before stopping, cancels listeners/timers/retries and
   prevents unload-time traffic, including cross-tab withdrawal and bfcache restore.
   Inventory exact owned keys and their scope before deleting any identifiers.
5. Verify supported initial/manual/automatic page-view ownership and deduplication
   across Next.js navigation and Back/Forward. Constrain raw URL/referrer reads before
   loading; a post-navigation React effect alone cannot protect a live embed.
6. Implement the reviewed loader, environment/location binding, route transitions,
   error isolation and narrow CSP destinations. Expand tests with actual backend
   evidence. Update disclosures to verified fields, cookies, retention and linkage.
   Version/re-prompt tracking consent for that actual behavior; do not automatically
   activate the preferences collected by this blocked implementation.
7. Only after separate approval may a release remove the code block and set the
   independent tracking flag. CRM sync, marketing, workflow review/publication and
   provider-ownership flags remain separately governed.

For this release, rollback is leaving `HIGHLEVEL_TRACKING_ENABLED=false`; the code
block provides a second barrier even if the flag is mistakenly true. There is no
active tracker or vendor data to unwind. Retain browser consent evidence and required
storage. Do not downgrade version-2 records to version 1. Any future enabled release
must document how it stops **already open documents**, not only new script loads.
