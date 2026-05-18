# TESTS

## OVERVIEW

Playwright browser specs live under `tests`; Node unit tests live beside source files as `src/**/*.test.ts`.

## STRUCTURE

```text
tests/
├── *.spec.ts              # route, navigation, responsive, performance specs
├── fixtures/*.json        # legacy fixture payloads
└── utils/                 # helpers and legacy endpoint fixtures
src/**/
└── *.test.ts              # Node test runner unit/route-handler coverage
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Config | `../playwright.config.ts` | Browser matrix, web server, trace/screenshot/video. |
| Helpers | `utils/test-helpers.ts` | Image checks, accessibility checks, performance helpers. |
| Mocked UX fixtures | `utils/api-mocks.ts` | Legacy client-side endpoint fixtures retained for older UX specs; not Sanity data-flow proof. |
| Route coverage | `*.spec.ts` | Homepage/contact/gallery/training/navigation/responsive/performance. |
| Unit coverage | `../src/**/*.test.ts` | `node:test` via `tsx --test`; colocated with implementation. |

## CONVENTIONS

- Prefer semantic selectors: `getByRole`, `getByLabel`, `getByPlaceholder`, landmarks.
- `data-testid` is not a current project convention.
- CI forbids `test.only`, retries twice, and uses one worker.
- Failure artifacts: HTML report, first-retry traces, failure screenshots, retained failure videos.
- Single browser runs use `--project=chromium`/`firefox`/`webkit`.
- Unit tests use Node's built-in test APIs; no Jest/Vitest config exists.

## COMMANDS

```bash
npm test
npm run test:ui
npm run test:headed
npm run test:debug
npm run test:unit
npx playwright test tests/homepage.spec.ts --project=chromium
```

## ANTI-PATTERNS

- Do not assume legacy endpoint fixtures reflect current production data flow; current app loads Sanity server-side.
- Do not leave `test.only`; Playwright config blocks it in CI.
- Do not add Jest, Vitest, or a second E2E framework without explicit approval.
