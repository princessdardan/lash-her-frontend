# Booking and HelcimPay Integration Plan

> **SUPERSEDED CHECKOUT STORAGE WARNING:** This historical integration plan predates the [2026-05-10 Private Checkout Storage Security Remediation Plan](./2026-05-10-private-checkout-storage-security-remediation.md). Do not follow the `checkoutOrder`, `Checkout Orders`, or `TCheckoutOrder` verification steps below. Checkout transaction history, customer PII, checkout tokens, Helcim invoice identifiers, Helcim transaction identifiers, payment reconciliation records, and encrypted Helcim secret tokens must remain in private PostgreSQL storage, not public Sanity documents or Studio Orders.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the completed Google Calendar booking worktree and HelcimPay checkout worktree into the main Lash Her codebase without overwriting the current uncommitted main-workspace UI/style/email work.

**Architecture:** Treat the current `main` checkout as protected WIP. Create a separate integration worktree from current `main`, merge the booking branch first, clean its whitespace issues, then merge the Helcim branch and resolve the two known semantic conflicts by preserving both feature additions. Review shared Sanity/data/config files, run focused and full validation from `frontend`, then bring the verified integration branch back into the main workspace only after the protected WIP is safely committed or intentionally stashed by the user.

**Tech Stack:** Git worktrees, Next.js 16 App Router, React 18, TypeScript strict, Sanity v4/next-sanity, Google Calendar API through `googleapis`, Upstash Redis REST through `@upstash/redis`, Helcim v2 API, HelcimPay.js, `tsx --test` unit tests, Playwright E2E.

---

## Integration scope locked by this plan

- Source branches: `feature/booking-system` and `feat/helcimpay-checkout`.
- Target base: current local `main`, including commit `7b5f819 docs: add booking system design`.
- Current main workspace uncommitted files are protected and must not be overwritten.
- Integration happens in a separate worktree/branch, not directly in `/Users/dardan/Documents/lash-her`.
- No destructive Git commands: no `git reset --hard`, no `git checkout -- .`, no `git clean -fd`, no force-push.
- The plan resolves only integration conflicts and validation failures caused by the two feature branches. It does not redesign booking, checkout, site navigation, or the current UI overhaul work.
- Any user WIP checkpoint commit or stash must be explicitly chosen by the user before the integrated branch is applied back to the main workspace.

If any of these locked choices are not acceptable, stop before Task 1 and revise this plan.

## Known analysis facts

- Main workspace: `/Users/dardan/Documents/lash-her`, branch `main`, ahead of `origin/main` by 4, with many protected uncommitted UI/style/email changes.
- Booking worktree: `.worktrees/booking-system`, branch `feature/booking-system`, clean, 22 commits ahead of current `main`.
- Helcim worktree: `.worktrees/helcimpay-checkout`, branch `feat/helcimpay-checkout`, clean, 19 commits ahead and missing current main commit `7b5f819`.
- Each feature branch merges into current `main` cleanly by itself.
- Combining both branches conflicts in exactly:
  - `frontend/src/data/loaders.ts`
  - `frontend/src/sanity/env.ts`
- Shared files that auto-merge but require semantic review:
  - `frontend/package.json`
  - `frontend/src/app/api/revalidate/route.ts`
  - `frontend/src/sanity/schemas/index.ts`
  - `frontend/src/sanity/structure/index.ts`
  - `frontend/src/types/index.ts`
- Booking has `git diff --check` trailing whitespace in:
  - `frontend/src/app/(site)/booking/page.tsx`
  - `frontend/src/components/booking/booking-flow.tsx`
- Current main dirty tracked files do not overlap the two feature branches' tracked files, but direct merging into the dirty workspace is still forbidden by this plan.

## Feature inventory

### Booking worktree introduces

- `frontend/src/app/(site)/booking/page.tsx`
- `frontend/src/app/api/booking/availability/route.ts`
- `frontend/src/app/api/booking/create/route.ts`
- `frontend/src/app/api/booking/oauth/start/route.ts`
- `frontend/src/app/api/booking/oauth/callback/route.ts`
- `frontend/src/components/booking/booking-flow.tsx`
- `frontend/src/components/booking/booking-entry-link.tsx`
- `frontend/src/lib/booking/*`
- `frontend/src/sanity/schemas/documents/booking-settings.ts`
- `frontend/src/sanity/schemas/documents/booking-marketing-opt-in.ts`
- `frontend/tests/booking.spec.ts`
- Booking additions to package scripts/deps, data loaders, Sanity schema registry, Studio structure, revalidation tags, and shared types.

### HelcimPay worktree introduces

- `frontend/src/app/(site)/shop/page.tsx`
- `frontend/src/app/(site)/shop/confirmation/page.tsx`
- `frontend/src/app/api/checkout/route.ts`
- `frontend/src/app/api/checkout/validate-payment/route.ts`
- `frontend/src/components/commerce/*`
- `frontend/src/lib/commerce/*`
- `frontend/src/sanity/schemas/documents/sellable-product.ts`
- `frontend/src/sanity/schemas/documents/checkout-order.ts`
- `frontend/tests/checkout.spec.ts`
- Commerce additions to package scripts, data loaders, Sanity schema registry, Studio structure, revalidation tags, env helpers, and shared types.

---

### Task 1: Protect current main workspace and create integration worktree

**Files:**
- No source file changes.

- [ ] **Step 1: Confirm main workspace WIP is protected**

Run from `/Users/dardan/Documents/lash-her`:

```bash
GIT_MASTER=1 git status --short --branch
GIT_MASTER=1 git log --oneline origin/main..main
GIT_MASTER=1 git worktree list --porcelain
```

Expected:
- Main workspace is still `main`.
- It is ahead of `origin/main` by local commits.
- It has uncommitted files that must not be overwritten.
- Existing feature worktrees are visible.

- [ ] **Step 2: Create a separate integration worktree from current main**

Run from `/Users/dardan/Documents/lash-her`:

```bash
GIT_MASTER=1 git worktree add .worktrees/booking-helcim-integration -b integration/booking-helcim main
```

Expected:
- A new clean worktree exists at `.worktrees/booking-helcim-integration`.
- The new branch starts from current local `main`, including `7b5f819`.

- [ ] **Step 3: Confirm integration worktree is clean**

Run from `.worktrees/booking-helcim-integration`:

```bash
GIT_MASTER=1 git status --short --branch
GIT_MASTER=1 git log --oneline -5
```

Expected:
- Branch is `integration/booking-helcim`.
- Working tree is clean.
- Latest history contains current local main commits.

---

### Task 2: Merge booking branch and fix known whitespace

**Files:**
- Merge from: `feature/booking-system`
- Known cleanup targets:
  - `frontend/src/app/(site)/booking/page.tsx`
  - `frontend/src/components/booking/booking-flow.tsx`

- [ ] **Step 1: Merge booking branch first**

Run from `.worktrees/booking-helcim-integration`:

```bash
GIT_MASTER=1 git merge --no-ff feature/booking-system
```

Expected:
- Merge completes without conflicts.
- Booking files are added.

If the merge unexpectedly conflicts, stop and inspect before editing. Do not guess.

- [ ] **Step 2: Check whitespace**

```bash
GIT_MASTER=1 git diff --check HEAD~1..HEAD
```

Expected before cleanup: trailing whitespace may be reported in the known booking files.

- [ ] **Step 3: Remove only trailing whitespace in known booking files**

Edit only:

```text
frontend/src/app/(site)/booking/page.tsx
frontend/src/components/booking/booking-flow.tsx
```

Do not alter booking behavior in this step.

- [ ] **Step 4: Verify whitespace cleanup**

```bash
GIT_MASTER=1 git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 5: Commit whitespace cleanup if the merge commit did not absorb it**

If Step 3 created a separate working-tree change, commit it separately:

```bash
GIT_MASTER=1 git add 'frontend/src/app/(site)/booking/page.tsx' frontend/src/components/booking/booking-flow.tsx
GIT_MASTER=1 git commit -m "fix: clean booking whitespace"
```

Expected: whitespace-only cleanup is isolated from semantic integration work.

---

### Task 3: Merge Helcim branch and resolve known conflicts

**Files:**
- Merge from: `feat/helcimpay-checkout`
- Expected conflicts:
  - `frontend/src/data/loaders.ts`
  - `frontend/src/sanity/env.ts`

- [ ] **Step 1: Merge Helcim branch second**

Run from `.worktrees/booking-helcim-integration`:

```bash
GIT_MASTER=1 git merge --no-ff feat/helcimpay-checkout
```

Expected:
- Git reports conflicts only in `frontend/src/data/loaders.ts` and `frontend/src/sanity/env.ts`.
- Shared files such as package, revalidation route, schema registry, Studio structure, and types auto-merge.

If any other file conflicts, stop and inspect why before editing.

- [ ] **Step 2: Resolve `frontend/src/data/loaders.ts` additively**

Keep all existing loader exports and preserve both feature additions:

- Booking import: `BookingSettings` type from `@/lib/booking/types`.
- Helcim import: `TSellableProduct` type from `@/types`.
- Booking function: `getBookingSettings()` with `bookingSettings` cache tag.
- Commerce functions: `getSellableProducts()` and `getSellableProductsByIds()` with `sellableProduct` cache tag.
- Export all three new loaders from `loaders`.

Do not refactor unrelated loader formatting during this conflict resolution.

- [ ] **Step 3: Resolve `frontend/src/sanity/env.ts` additively**

Preserve existing env behavior and include all new helpers:

- `getBookingEnv()` for Google OAuth, booking setup secret, and Upstash Redis env values.
- `getHelcimGeneralApiToken()` for `HELCIM_GENERAL_API_TOKEN` and `getHelcimTransactionApiToken()` for `HELCIM_TRANSACTION_API_TOKEN`.
- `getCheckoutSecretEncryptionKey()` for validated base64 32-byte `CHECKOUT_SECRET_ENCRYPTION_KEY`.
- Shared `assertValue()` helper remains single and unchanged except as needed for formatting.

Do not rename unrelated env variables in this plan.

- [ ] **Step 4: Confirm conflict markers are gone**

```bash
rg '<<<<<<<|=======|>>>>>>>' frontend/src/data/loaders.ts frontend/src/sanity/env.ts
```

Expected: no output.

- [ ] **Step 5: Stage and complete merge**

```bash
GIT_MASTER=1 git add frontend/src/data/loaders.ts frontend/src/sanity/env.ts
GIT_MASTER=1 git status --short
GIT_MASTER=1 git commit
```

Expected:
- The merge commit completes.
- Only intended conflict files were manually resolved.

---

### Task 4: Review auto-merged shared integration surfaces

**Files:**
- `frontend/package.json`
- `frontend/src/app/api/revalidate/route.ts`
- `frontend/src/sanity/schemas/index.ts`
- `frontend/src/sanity/structure/index.ts`
- `frontend/src/types/index.ts`

- [ ] **Step 1: Review package scripts and dependencies**

Check `frontend/package.json` for both feature requirements:

- `test:unit`: `tsx --test "src/**/*.test.ts"`
- Booking deps: `@sanity/icons`, `@upstash/redis`, `googleapis`
- Existing app deps and scripts preserved.

If `tsx` is already available transitively but not explicitly listed, decide during implementation whether package metadata should explicitly add it. Do not add package changes without validating current install behavior.

- [ ] **Step 2: Review revalidation tag map**

Check `frontend/src/app/api/revalidate/route.ts` includes both:

```ts
bookingSettings: "bookingSettings"
sellableProduct: "sellableProduct"
```

Also preserve existing anti-pattern constraints from project guidance:

- Do not call `req.json()` before `parseBody()`.
- Keep `revalidateTag(tag, { expire: 0 })` usage.

- [ ] **Step 3: Review Sanity schema registry**

Check `frontend/src/sanity/schemas/index.ts` registers all four new document schemas:

- `bookingSettings`
- `bookingMarketingOptIn`
- `sellableProduct`
- `checkoutOrder`

- [ ] **Step 4: Review Studio structure**

Check `frontend/src/sanity/structure/index.ts` exposes:

- Booking Settings singleton.
- Booking Marketing Opt-ins list.
- Sellable Products list.
- Checkout Orders list.

Keep the existing singleton/page/content/submission organization intact.

- [ ] **Step 5: Review shared types**

Check `frontend/src/types/index.ts` includes:

- Booking type exports from `@/lib/booking/types`.
- `TSellableProduct`, `TCheckoutOrder`, and related commerce types.

Avoid duplicating equivalent types with incompatible names or shapes.

---

### Task 5: Run static validation and focused tests

**Files:**
- No planned source file changes unless validation identifies integration-caused failures.

- [ ] **Step 1: Run diagnostics on manually resolved files**

Use language-server diagnostics for:

```text
frontend/src/data/loaders.ts
frontend/src/sanity/env.ts
frontend/package.json
frontend/src/app/api/revalidate/route.ts
frontend/src/sanity/schemas/index.ts
frontend/src/sanity/structure/index.ts
frontend/src/types/index.ts
```

Expected: no new type or syntax errors in integration-touched shared files.

- [ ] **Step 2: Run unit tests**

Run from `frontend`:

```bash
npm run test:unit
```

Expected:
- Booking and commerce unit tests pass.
- If missing env causes failures, identify whether tests incorrectly import server env eagerly. Fix only integration-caused or branch-caused issues.

- [ ] **Step 3: Run lint**

```bash
npm run lint
```

Expected: no lint errors introduced by integration.

- [ ] **Step 4: Run build**

```bash
npm run build
```

Expected:
- Build exits 0, or any pre-existing unrelated failure is documented with exact error text.
- Do not silently fix unrelated UI-overhaul or dependency issues unless they block integration and are proven caused by these merges.

---

### Task 6: Run browser smoke coverage

**Files:**
- No planned source file changes unless browser tests reveal integration-caused failures.

- [ ] **Step 1: Run existing stable site smoke tests**

Run from `frontend`:

```bash
npx playwright test tests/homepage.spec.ts --project=chromium
```

Expected: existing homepage behavior still passes.

- [ ] **Step 2: Run booking browser tests**

```bash
npx playwright test tests/booking.spec.ts --project=chromium
```

Expected:
- Booking page renders.
- Mocked availability and create routes support the expected flow.

- [ ] **Step 3: Run checkout browser tests**

```bash
npx playwright test tests/checkout.spec.ts --project=chromium
```

Expected:
- Shop page renders.
- Mocked Helcim script and API routes exercise failure and success paths.

- [ ] **Step 4: Manually smoke new routes if tests are inconclusive**

If Playwright cannot validate because content/env is unavailable, run the app and manually inspect:

```bash
npm run dev
```

Routes:

```text
/booking?type=training-call
/shop
/shop/confirmation
```

Expected:
- Pages render without runtime crashes.
- No secret values appear in the browser or console.

---

### Task 7: Final integration review and handoff

**Files:**
- No planned source file changes unless final review reveals integration-caused issues.

- [ ] **Step 1: Review final diff against main**

Run from `.worktrees/booking-helcim-integration`:

```bash
GIT_MASTER=1 git diff --stat main...HEAD
GIT_MASTER=1 git diff --name-status main...HEAD
```

Expected:
- Diff contains booking and commerce additions plus shared integration files.
- No current main workspace UI/style/email WIP files are unexpectedly included.

- [ ] **Step 2: Confirm no conflict markers or whitespace errors**

```bash
rg '<<<<<<<|=======|>>>>>>>' frontend
GIT_MASTER=1 git diff --check main...HEAD
```

Expected: no output.

- [ ] **Step 3: Record validation results**

In the implementation summary or PR description, record exact pass/fail status for:

- `npm run test:unit`
- `npm run lint`
- `npm run build`
- `npx playwright test tests/homepage.spec.ts --project=chromium`
- `npx playwright test tests/booking.spec.ts --project=chromium`
- `npx playwright test tests/checkout.spec.ts --project=chromium`

Do not claim a command passed unless it was run and exited 0.

- [ ] **Step 4: Prepare apply-back strategy for main workspace**

Before bringing integrated changes back to `/Users/dardan/Documents/lash-her`, require one of these user-approved states:

1. Current main WIP is committed.
2. Current main WIP is intentionally stashed.
3. Current main WIP is preserved as patch files and the user accepts the risk.

Recommended after approval:

```bash
GIT_MASTER=1 git merge --no-ff integration/booking-helcim
```

Run this only from a clean or explicitly protected main workspace.

---

## Rollback and recovery

During a conflicted merge in the integration worktree:

```bash
GIT_MASTER=1 git merge --abort
```

If the integration worktree becomes unrecoverably messy and has no valuable uncommitted changes:

```bash
GIT_MASTER=1 git worktree remove .worktrees/booking-helcim-integration
```

Do not use destructive commands in the main workspace. If uncertain, stop and ask.

## Success criteria

- Main workspace WIP remains untouched throughout integration planning and validation.
- Integration branch starts from current local `main`, including `7b5f819`.
- `feature/booking-system` and `feat/helcimpay-checkout` are both merged.
- `frontend/src/data/loaders.ts` preserves booking and commerce loaders.
- `frontend/src/sanity/env.ts` preserves booking and Helcim env helpers.
- Auto-merged shared files are semantically reviewed.
- Booking whitespace issues are fixed.
- Static validation, unit tests, and browser smoke tests are run with honest recorded results.
- Any final merge into main happens only after the user explicitly protects current WIP.
