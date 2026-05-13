# PLAYWRIGHT TESTS

## OVERVIEW

E2E-only Playwright suite. Tests live under `tests` and auto-start the Next dev server on port 3000.

## STRUCTURE

```text
tests/
├── *.spec.ts              # route, navigation, responsive, performance specs
├── fixtures/*.json        # legacy fixture payloads
└── utils/                 # helpers and API mocks
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Config | `../playwright.config.ts` | Browser matrix, web server, trace/screenshot/video. |
| Helpers | `utils/test-helpers.ts` | Image checks, accessibility checks, performance helpers. |
| Mocks | `utils/api-mocks.ts` | Legacy Strapi-style endpoint mocks. |
| Route coverage | `*.spec.ts` | Homepage/contact/gallery/training/navigation/responsive/performance. |

## CONVENTIONS

- Prefer semantic selectors: `getByRole`, `getByLabel`, `getByPlaceholder`, landmarks.
- `data-testid` is not a current project convention.
- CI forbids `test.only`, retries twice, and uses one worker.
- Failure artifacts: HTML report, first-retry traces, failure screenshots, retained failure videos.
- Single browser runs use `--project=chromium`/`firefox`/`webkit`.

## COMMANDS

```bash
npm test
npm run test:ui
npm run test:headed
npm run test:debug
npx playwright test tests/homepage.spec.ts --project=chromium
```

## ANTI-PATTERNS

- Do not assume API mocks reflect current production data flow; current app loads Sanity server-side.
- Do not leave `test.only`; Playwright config blocks it in CI.
- Do not add a second E2E framework without explicit approval.
