# Testing Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make test coverage visible and enforceable, prove test effectiveness with mutation testing, establish a continuous quality dashboard, and eliminate lint warnings and skipped tests.

**Architecture:** The plan hardens the testing pipeline by adding c8 coverage thresholds, integrating Codecov for PR feedback, running Stryker mutation tests weekly, and enforcing zero-warnings lint gates in CI. It also fixes existing skipped tests and lint warnings before adding new infrastructure.

**Tech Stack:** Node.js test runner, c8, Stryker, Codecov, SonarQube Cloud, ESLint, GitHub Actions, Playwright.

---

**Source:** docs/platform-comprehensive-after-action-review.md  
**Master Spec:** docs/superpowers/specs/2026-06-05-platform-remediation-master-design.md

## Implementation Metadata

| Field                                      | Value                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Category**                               | Testing                                                                                                                      |
| **Source AAR Issues**                      | 6.1–6.4                                                                                                                      |
| **Estimated Duration**                     | 3 weeks (Phase 0 + Phase 4)                                                                                                  |
| **Required Sub-Skill for Agentic Workers** | Node.js test runner, code coverage tooling, mutation testing concepts, ESLint plugin configuration, CI/CD workflow authoring |

---

## Files to Create

| File                                     | Purpose                                   |
| ---------------------------------------- | ----------------------------------------- |
| `.c8rc.json`                             | c8 coverage configuration with thresholds |
| `.github/workflows/coverage.yml`         | Codecov upload workflow                   |
| `.github/workflows/mutation-testing.yml` | Weekly Stryker run                        |
| `stryker.config.json`                    | Stryker mutation testing configuration    |
| `.github/workflows/sonar.yml`            | SonarQube scan workflow                   |

## Files to Modify

| File                                                  | Change                                                                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                        | Add `test:unit:coverage` script; add `c8`, `@stryker-mutator/core`, `eslint-plugin-jest-playwright` dev dependencies |
| `tests/utils/test-helpers.ts`                         | Update existing helper file with assertion helpers                                                                   |
| `tests/gallery.spec.ts`                               | Fix or delete skipped lightbox test; add assertions to conditional blocks                                            |
| `src/components/custom/layouts/cta-section-image.tsx` | Fix lint warning (unused import)                                                                                     |
| `src/lib/commerce/cart-storage.ts`                    | Fix lint warning                                                                                                     |
| `eslint.config.mjs`                                   | Add `jest-playwright` plugin and `expect-expect` rule                                                                |
| `.github/workflows/ci.yml`                            | Add coverage upload step                                                                                             |

---

## Ordered Tasks

### Phase 0: Immediate Fixes (Week 1)

#### Task 0.1: Fix lint warnings

- [ ] `src/components/custom/layouts/cta-section-image.tsx` — remove unused import (line 14)
- [ ] `src/lib/commerce/cart-storage.ts` — fix warning (line 25)
- [ ] `tests/gallery.spec.ts` — fix warnings (lines 56, 104)
- [ ] Verify: `npm run lint` returns 0 errors, 0 warnings

#### Task 0.2: Fix or delete skipped tests

- [ ] `tests/gallery.spec.ts:63` — skipped lightbox test:
  - Default action: fix the test by adding the missing `data-testid` or correcting the selector so the lightbox interaction is asserted.
  - Deletion is allowed only if the implementation review confirms the lightbox feature has been removed from the product.
- [ ] `tests/gallery.spec.ts:53-60` and `:103-113` — conditional tests without assertions:
  - Add explicit `expect` assertions
  - Or convert to deterministic tests (remove conditionals)
- [ ] Search for other skipped tests:
  ```bash
  grep -r "test.skip\|it.skip\|describe.skip" tests/ src/
  ```
- [ ] Verify: `npm test` passes with zero skipped tests

#### Task 0.3: Add coverage instrumentation

- [ ] Install `c8`:
  ```bash
  npm install -D c8
  ```
- [ ] Add to `package.json`:
  ```json
  {
    "scripts": {
      "test:unit": "tsx --test 'src/**/*.test.ts'",
      "test:unit:coverage": "c8 tsx --test 'src/**/*.test.ts'"
    }
  }
  ```
- [ ] Create `.c8rc.json`:
  ```json
  {
    "check-coverage": true,
    "lines": 70,
    "functions": 60,
    "branches": 50,
    "statements": 70,
    "reporter": ["text", "lcov", "html"],
    "exclude": ["src/**/*.test.ts", "tests/", "scripts/"]
  }
  ```
- [ ] Verify: `npm run test:unit:coverage` generates `coverage/` directory with LCOV

---

### Phase 4: Quality Infrastructure (Weeks 8–9)

#### Task 4.1: Integrate Codecov

- [ ] Sign up for Codecov (free for open source)
- [ ] Add repository to Codecov
- [ ] Create `.github/workflows/coverage.yml`:
  ```yaml
  name: Coverage
  on:
    pull_request:
      branches: [main]
    push:
      branches: [main]
  jobs:
    coverage:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 20
            cache: npm
        - run: npm ci
        - run: npm run test:unit:coverage
        - uses: codecov/codecov-action@v4
          with:
            files: ./coverage/lcov.info
            fail_ci_if_error: true
  ```
- [ ] Add Codecov badge to README
- [ ] Verify: PR comment shows coverage delta

#### Task 4.2: Set up mutation testing

- [ ] Install Stryker:
  ```bash
  npm install -D @stryker-mutator/core
  ```
- [ ] Create `stryker.config.json`:
  ```json
  {
    "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
    "packageManager": "npm",
    "reporters": ["html", "clear-text", "progress"],
    "testRunner": "command",
    "commandRunner": {
      "command": "npm run test:unit"
    },
    "coverageAnalysis": "perTest",
    "mutate": ["src/**/*.ts", "!src/**/*.test.ts", "!src/sanity/**/*"],
    "thresholds": {
      "break": 60,
      "high": 80,
      "low": 50
    }
  }
  ```
- [ ] Create `.github/workflows/mutation-testing.yml`:
  ```yaml
  name: Mutation Testing
  on:
    schedule:
      - cron: "0 2 * * 0" # Sundays 2 AM
  jobs:
    mutation:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 20
            cache: npm
        - run: npm ci
        - run: npx stryker run
        - uses: actions/upload-artifact@v4
          with:
            name: mutation-report
            path: reports/mutation/html/
  ```
- [ ] Verify: Stryker runs and generates HTML report

#### Task 4.3: Set up quality dashboard (SonarQube Cloud)

- [ ] Sign up at sonarcloud.io
- [ ] Add project; get `SONAR_TOKEN`
- [ ] Create `.github/workflows/sonar.yml`:
  ```yaml
  name: SonarQube
  on: [push, pull_request]
  jobs:
    sonar:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
          with:
            fetch-depth: 0
        - uses: SonarSource/sonarqube-scan-action@v4
          env:
            SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
  ```
- [ ] Create `sonar-project.properties`:
  ```properties
  sonar.projectKey=lash-her-frontend
  sonar.organization=princessdardan
  sonar.sources=src
  sonar.tests=src,tests
  sonar.test.inclusions=**/*.test.ts,**/*.spec.ts
  sonar.javascript.lcov.reportPaths=coverage/lcov.info
  ```
- [ ] Verify: dashboard shows coverage, duplication, and complexity

> **Alternative**: Code Climate offers a simpler setup with fewer configuration steps. Use it if SonarQube Cloud onboarding exceeds team capacity.

#### Task 4.4: Add test-quality linting

- [ ] Install plugin:
  ```bash
  npm install -D eslint-plugin-jest-playwright
  ```
- [ ] Update `eslint.config.mjs`:

  ```javascript
  import jestPlaywright from "eslint-plugin-jest-playwright";

  export default [
    // ...existing config...
    {
      files: ["tests/**/*.ts", "src/**/*.test.ts"],
      plugins: {
        "jest-playwright": jestPlaywright,
      },
      rules: {
        "jest-playwright/expect-expect": "error",
        "jest-playwright/max-nested-describe": ["warn", { max: 3 }],
      },
    },
  ];
  ```

- [ ] Verify: `npm run lint` catches tests without assertions

#### Task 4.5: Enforce zero warnings and no skipped tests in CI

- [ ] Update `.github/workflows/ci.yml`:
  ```yaml
  - run: npm run lint -- --max-warnings=0
  - run: npm run test:unit
  - run: |
      if grep -r "test.skip\|it.skip\|describe.skip" tests/ src/; then
        echo "Error: Skipped tests found"
        exit 1
      fi
  ```
- [ ] Verify: CI fails if lint warnings or skipped tests exist

---

## Verification Commands

```bash
# Build
npm run build

# Lint (zero warnings)
npm run lint -- --max-warnings=0

# Unit tests with coverage
npm run test:unit:coverage

# Check for skipped tests
grep -r "test.skip\|it.skip\|describe.skip" tests/ src/

# Mutation testing
npx stryker run

# E2E tests
npm test
```

---

## Rollout Gates

| Gate | Criteria                                          | Owner       |
| ---- | ------------------------------------------------- | ----------- |
| G1   | Zero lint warnings on main                        | Backend dev |
| G2   | Zero skipped tests on main                        | QA          |
| G3   | Coverage report generated on every PR             | DevOps      |
| G4   | Codecov PR comments show delta                    | DevOps      |
| G5   | CI fails on coverage drop > 1%                    | DevOps      |
| G6   | Stryker runs weekly and generates report          | QA          |
| G7   | Quality dashboard shows trends                    | QA          |
| G8   | Test-quality linting catches assertion-less tests | Backend dev |

---

## Notes and Cautions

1. **Coverage Thresholds**: Start conservative (70% lines) and raise quarterly. Setting thresholds too high initially causes friction and gaming.
2. **Stryker Speed**: Mutation testing is slow. Run it weekly off-peak, not on every PR. Use `coverageAnalysis: "perTest"` to speed up.
3. **Skipped Tests**: Before deleting a skipped test, verify it is not covering a critical path. If the feature is broken, create a bug ticket instead of silently deleting.
4. **Quality dashboard default**: Use SonarQube Cloud for code quality, security, duplication, and coverage trend tracking. Code Climate is an acceptable substitute only if SonarQube Cloud procurement is blocked.
5. **Lint Staged Scope**: `lint-staged` should only run on changed files. Do not run full test suite on every commit — it is too slow.
6. **Coverage Exclusions**: Exclude generated files, Sanity schema definitions, and test files from coverage. Focus on business logic.
