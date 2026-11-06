# CI Sanity binding correction

The CI database-test, build and browser configurations, including Playwright's commerce-server override, now select the reviewed staging CMS pair `7o23yrvk/staging-2026-05-10`. The base source selected the old project's staging dataset. The canonical staging pair is recorded in the accepted October 22 setup and October 23 deployed public-page checks; their exact source hashes are in `validation.json`.

The prebuild change accepts only that exact additional pair for non-hosted local/CI runs. It leaves the business application environment `local`. The actual gateway transport is exercised with synthetic HTTPS origins and refuses configuration before any fetch. Existing local project `3auncj84` dataset support, production `3auncj84/production`, and strict hosted team/project/target checks are retained. No hosted identity is synthesized.

`original-validator-refusal.json` retains an actual replay of the exact base validator in an isolated temporary directory with only public configuration: the reviewed staging pair previously exited 1. `offline-client-binding.json` inspects the unchanged actual client without making a request: the corrected tuple still selects the public API, with no token. The fixture does not replace Sanity or return empty content.

The final focused suite passed 53 tests with no skips, targeted ESLint passed, full TypeScript checking passed, and `git diff --check` passed. `check-results.json` records exact commands; logs contain no live configuration or credentials. The focused tests cover the new exact tuple, wrong staging datasets, retained local datasets, actual gateway refusal, and invalid hosted identities. Validation uses Node 24.18.0 and the checked-in dependency tree.

This is offline source qualification. The root supplied the latest CI build/WebKit quota failure; this correction does not claim a new CI build, browser pass, staging availability, or quota state. Fresh CI must establish those results. No Sanity/API, credential-store, account/usage/billing, or deployment request was performed.
