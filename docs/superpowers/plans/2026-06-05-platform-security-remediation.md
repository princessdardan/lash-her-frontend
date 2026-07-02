# Security Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement defense-in-depth security controls across the application, including CSP, rate limiting, request guarding, link validation, and secret management, without breaking existing functionality.

**Architecture:** The plan establishes a middleware-based security foundation (CSP nonces, request IDs, UA validation) and layers on runtime hardening: a token-bucket KV rate limiter, HMAC-signed nonces for replay protection, a CMS link resolution service to prevent unsafe hrefs, and a vault-integrated token encryption scheme for calendar OAuth. Dependency vulnerability management is automated through Renovate and CI audit gates.

**Tech Stack:** Next.js Edge middleware, Upstash Redis, Web Crypto API (AES-256-GCM, HMAC-SHA256), Google Secret Manager, Renovate, GitHub Actions.

---

**Source:** docs/platform-comprehensive-after-action-review.md  
**Master Spec:** docs/superpowers/specs/2026-06-05-platform-remediation-master-design.md

## Implementation Metadata

| Field                                      | Value                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **Category**                               | Security                                                                                                |
| **Source AAR Issues**                      | 1.1–1.7                                                                                                 |
| **Estimated Duration**                     | 2 weeks (Phase 1 + Phase 2)                                                                             |
| **Required Sub-Skill for Agentic Workers** | Node.js/Next.js backend development, Redis/KV operations, cryptography basics, CI/CD workflow authoring |

---

## Files to Create

| File                                      | Purpose                                                               |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `src/middleware.ts`                       | Edge middleware for UA validation, nonce generation, header injection |
| `src/lib/security/csp-policy.ts`          | Environment-aware CSP builder with report-only mode                   |
| `src/lib/security/kv-rate-limiter.ts`     | Token-bucket rate limiter using Upstash Redis                         |
| `src/lib/security/request-signer.ts`      | HMAC-signed nonce generator and verifier                              |
| `src/lib/security/request-guard.ts`       | Global request size/shape/depth limiter                               |
| `src/lib/security/cms-link-validation.ts` | Shared protocol allowlist for CMS links                               |
| `src/lib/cms-link-resolver.ts`            | Link resolution service with audit logging                            |
| `src/lib/security/token-crypto.ts`        | AES-256-GCM encrypt/decrypt for KV tokens                             |
| `src/lib/booking/calendar-auth.ts`        | Vault-aware calendar token refresh                                    |
| `src/components/ui/safe-link.tsx`         | Link wrapper that uses resolver                                       |
| `scripts/audit-cms-links.ts`              | Build-time audit that fails CI on unsafe/unresolved CMS links         |
| `.github/renovate.json`                   | Renovate configuration with auto-merge rules                          |
| `docs/security-runbook.md`                | Secret rotation and incident response procedures                      |

## Files to Modify

| File                                                | Change                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `next.config.ts`                                    | Add `headers()` export for fallback security headers                                                              |
| `src/app/layout.tsx`                                | Read CSP nonce from request header; inject into meta tag                                                          |
| `src/app/(site)/layout.tsx`                         | Same nonce propagation                                                                                            |
| `src/app/actions/form.ts`                           | Replace in-memory Map with `kv-rate-limiter`                                                                      |
| `src/app/api/checkout/route.ts`                     | Wrap POST with rate limiter, request guard, and signed nonce                                                      |
| `src/app/api/training-checkout/route.ts`            | Same as checkout                                                                                                  |
| `src/app/api/booking/holds/route.ts`                | Same as checkout                                                                                                  |
| `src/app/api/booking/checkout/route.ts`             | Rate limiter + signed nonce                                                                                       |
| `src/app/api/booking/oauth/callback/route.ts`       | Send refresh token to vault instead of KV                                                                         |
| `src/lib/booking/operational-store.ts`              | Encrypt access token; remove plaintext refresh token storage                                                      |
| `src/app/main-menu.tsx`                             | Replace direct `Link` with `SafeLink`                                                                             |
| `src/components/ui/portable-text-renderer.tsx`      | Replace direct `a href` with `SafeLink`                                                                           |
| `src/components/custom/layouts/feature-section.tsx` | Replace direct `Link`/`a` with `SafeLink`                                                                         |
| `package.json`                                      | Add `overrides` for vulnerable transitive dependencies                                                            |
| `.github/workflows/ci.yml`                          | Extend DevOps-owned workflow with audit/link-scan/security jobs; do not create this workflow in the Security plan |
| `.gitignore`                                        | Ensure `.env.local` and `.env.*.local` are ignored                                                                |
| `README.md`                                         | Document local dev with 1Password/Doppler                                                                         |

---

## Ordered Tasks

### Phase 1: Shared Security Infrastructure (Week 1)

#### Task 1.1: Create middleware layer

- [ ] Create `src/lib/security/csp-policy.test.ts` first:

  ```typescript
  import { describe, it } from "node:test";
  import assert from "node:assert/strict";
  import { buildCsp } from "./csp-policy";

  describe("buildCsp", () => {
    it("includes the nonce and required base directives", () => {
      const csp = buildCsp("abc123", "production");
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /script-src 'self' 'nonce-abc123'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /report-to csp-endpoint/);
    });
  });
  ```

- [ ] Run `npx tsx --test src/lib/security/csp-policy.test.ts`; expected before implementation: module import fails because `src/lib/security/csp-policy.ts` does not exist
- [ ] Create `src/middleware.ts` with User-Agent validation, per-request nonce generation via `crypto.getRandomValues`, `X-Request-Id` header generation, and matcher config `/((?!api|_next/static|_next/image|favicon.ico|studio).*)`
- [ ] Add fallback headers in `next.config.ts` for static assets
- [ ] Propagate nonce via request header to `src/app/layout.tsx`
- [ ] Verify: `curl -I http://localhost:3000/` shows `X-Request-Id` and `X-CSP-Nonce`

#### Task 1.2: Implement CSP policy builder

- [ ] Create `src/lib/security/csp-policy.ts`:
  - `buildCsp(nonce, env)` returns directive string
  - Production: enforced CSP + `report-to csp-endpoint`
  - Staging/development: `Content-Security-Policy-Report-Only`
  - Include `default-src 'self'`, `script-src 'self' 'nonce-{nonce}'`, `style-src 'self' 'nonce-{nonce}'`, `img-src 'self' data: https://cdn.sanity.io`, `connect-src 'self'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `upgrade-insecure-requests`
- [ ] Inject CSP in middleware response headers
- [ ] Add HSTS header in production: `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- [ ] Add `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- [ ] Run `npx tsx --test src/lib/security/csp-policy.test.ts`; expected after implementation: test passes
- [ ] Verify: staging shows `Report-Only`; production shows enforced

#### Task 1.3: Create global request guard

- [ ] Create `src/lib/security/request-guard.test.ts` first:

  ```typescript
  import { describe, it } from "node:test";
  import assert from "node:assert/strict";
  import { assertDepthLimits } from "./request-guard";

  describe("request guard depth limits", () => {
    it("rejects strings over the configured max length", () => {
      assert.throws(
        () =>
          assertDepthLimits(
            { message: "x".repeat(11) },
            {
              maxStringLength: 10,
              maxArrayLength: 10,
              maxObjectDepth: 5,
              maxObjectKeys: 20,
            },
          ),
        /string length/i,
      );
    });
  });
  ```

- [ ] Run `npx tsx --test src/lib/security/request-guard.test.ts`; expected before implementation: module import fails or `assertDepthLimits` is not exported
- [ ] Create `src/lib/security/request-guard.ts`:
  - `guardRequest(request, options)` returns parsed body
  - Default limits: 64 KB body, 1024 char strings, 50 array items, 10 object depth
  - Export `assertPayloadSize`, `assertDepthLimits`, `assertStringLength`, `assertArrayLength`
- [ ] Create HOF `withRequestGuard(handler, options)` for API routes
- [ ] Apply to all public POST routes
- [ ] Log rejected payloads with `requestId` and IP
- [ ] Run `npx tsx --test src/lib/security/request-guard.test.ts`; expected after implementation: test passes
- [ ] Verify: oversized payload returns 413; deep JSON returns 400

#### Task 1.4: Fix secret hygiene (Phase 0 carryover)

- [ ] Run `git rm --cached .env.local` if tracked
- [ ] Verify `.gitignore` includes `*.env*`, `.env.local`, `.env.*.local`
- [ ] Install `detect-secrets`: `pip install detect-secrets` or `brew install detect-secrets`
- [ ] Run `detect-secrets scan > .secrets.baseline`
- [ ] Add `.pre-commit-config.yaml` with detect-secrets hook
- [ ] Document local dev workflow with 1Password CLI in README
- [ ] Verify: `git ls-files | grep '\.env'` returns empty

---

### Phase 2: Runtime Hardening (Week 2)

#### Task 2.1: Implement KV rate limiter

- [ ] Create `src/lib/security/kv-rate-limiter.test.ts` first with a fake Redis adapter that returns counts 1 through 11 and asserts the 11th checkout request is limited for a limit of 10:

  ```typescript
  import { describe, it } from "node:test";
  import assert from "node:assert/strict";
  import { checkKvRateLimitWithClient } from "./kv-rate-limiter";

  describe("checkKvRateLimitWithClient", () => {
    it("limits after the configured threshold", async () => {
      let count = 0;
      const client = {
        pipeline: () => ({
          incr: () => undefined,
          expire: () => undefined,
          exec: async () => [++count],
        }),
      };
      let result = { limited: false, remaining: 10 };
      for (let i = 0; i < 11; i += 1) {
        result = await checkKvRateLimitWithClient(
          client as never,
          "checkout:ip:nonce",
          10,
          60,
        );
      }
      assert.equal(result.limited, true);
      assert.equal(result.remaining, 0);
    });
  });
  ```

- [ ] Run `npx tsx --test src/lib/security/kv-rate-limiter.test.ts`; expected before implementation: module import fails or `checkKvRateLimitWithClient` is not exported
- [ ] Create `src/lib/security/kv-rate-limiter.ts`:
  - Use existing `@upstash/redis`
  - Export `checkKvRateLimitWithClient(client, key, limit, windowSeconds)` for testability
  - `checkKvRateLimit(key, limit, windowSeconds)` returns `{ limited, remaining }`
  - Token bucket with `INCR` and `EXPIRE` via pipeline
  - Composite key: `{route}:{ip}:{nonce}`
- [ ] Define per-route limits:
  - `/api/checkout`: 10/minute
  - `/api/training-checkout`: 10/minute
  - `/api/booking/holds`: 20/minute
  - `/api/booking/checkout`: 10/minute
  - `/actions/form`: 30/minute
  - `/api/revalidate`: IP-allowlist only
- [ ] Replace in-memory Map in `src/app/actions/form.ts`
- [ ] Wrap checkout, training-checkout, booking holds, booking checkout
- [ ] Graceful degradation: if KV unavailable, allow and log warning
- [ ] Run `npx tsx --test src/lib/security/kv-rate-limiter.test.ts`; expected after implementation: test passes
- [ ] Verify: rapid POSTs to `/api/checkout` return 429 after 10 requests

#### Task 2.2: Implement signed nonces

- [ ] Create `src/lib/security/request-signer.test.ts` first:

  ```typescript
  import { describe, it } from "node:test";
  import assert from "node:assert/strict";
  import { signNonce, verifyNonce } from "./request-signer";

  describe("request signer", () => {
    it("verifies untampered payloads and rejects tampered payloads", async () => {
      const secret = "a".repeat(64);
      const payload = "checkout:order_1:nonce_1";
      const signature = await signNonce(payload, secret);
      assert.equal(await verifyNonce(payload, signature, secret), true);
      assert.equal(
        await verifyNonce(`${payload}:tampered`, signature, secret),
        false,
      );
    });
  });
  ```

- [ ] Run `npx tsx --test src/lib/security/request-signer.test.ts`; expected before implementation: module import fails because `request-signer.ts` does not exist
- [ ] Create `src/lib/security/request-signer.ts`:
  - `signNonce(payload, secret)` returns HMAC-SHA256 base64
  - `verifyNonce(payload, signature, secret)` returns boolean
  - Secret from `REQUEST_SIGNING_SECRET` env var (32-byte hex)
- [ ] Generate nonce on checkout/booking hold form render
- [ ] Include nonce in POST payload
- [ ] Verify nonce in API route before processing
- [ ] Store used nonces in KV with 5-minute TTL to prevent replay
- [ ] Run `npx tsx --test src/lib/security/request-signer.test.ts`; expected after implementation: test passes
- [ ] Verify: replaying same payload with same nonce returns 400

#### Task 2.3: Implement link resolution service

- [ ] Create `src/lib/cms-link-resolver.test.ts` first:

  ```typescript
  import { describe, it } from "node:test";
  import assert from "node:assert/strict";
  import { resolveCmsLink } from "./cms-link-resolver";

  describe("resolveCmsLink", () => {
    it("rejects javascript links and allows safe relative links", () => {
      assert.deepEqual(resolveCmsLink("javascript:alert(1)"), {
        href: "#",
        isExternal: false,
        isSafe: false,
      });
      assert.equal(resolveCmsLink("/services").href, "/services");
    });
  });
  ```

- [ ] Run `npx tsx --test src/lib/cms-link-resolver.test.ts`; expected before implementation: module import fails because `cms-link-resolver.ts` does not exist
- [ ] Create `src/lib/security/cms-link-validation.ts`:
  - `ALLOWED_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:']`
  - `isValidCmsLink(href)` returns boolean
- [ ] Create `src/lib/cms-link-resolver.ts`:
  - `resolveCmsLink(raw)` returns `{ href, isExternal, isSafe }`
  - Unsafe links log warning in dev/staging and return `href: '#'`
- [ ] Create `src/components/ui/safe-link.tsx`:
  - Wraps Next.js `Link` and native `a`
  - Uses `resolveCmsLink` for href validation
  - Renders `span` for unsafe links
- [ ] Replace direct links in:
  - `src/app/main-menu.tsx`
  - `src/components/ui/portable-text-renderer.tsx`
  - `src/components/custom/layouts/feature-section.tsx`
- [ ] Add build-time script `scripts/audit-cms-links.ts`:
  - Walk all CMS documents with link fields
  - Assert every `href` resolves through `resolveCmsLink` without returning `#`
  - Fail CI on unresolved or unsafe links
- [ ] Validate Sanity source-driven schema for CMS URL fields:
  - Verify `src/sanity/schemas/objects/shared/link.ts` enforces `http:`, `https:`, `mailto:`, `tel:` protocol allowlist
  - Verify `src/sanity/schemas/objects/layout/feature-section.ts` inline `link.href` uses the same allowlist (or migrate to the shared `link` type)
  - Verify `src/sanity/schemas/documents/product.ts`, `src/sanity/schemas/documents/service.ts`, and `src/sanity/schemas/objects/layout/hero-section.ts` use the shared `link` type for all URL fields
  - If any inline `href` fields lack validation, add `Rule.custom()` with the protocol allowlist
- [ ] Deploy updated schema to staging: `npx sanity schema deploy`
  - Production deploy requires `SANITY_SCHEMA_DEPLOY_TARGET=production`
- [ ] Run `npx tsx --test src/lib/cms-link-resolver.test.ts`; expected after implementation: test passes
- [ ] Verify: `javascript:alert(1)` in CMS renders as non-clickable span

#### Task 2.4: Implement token vault integration

- [ ] Create `src/lib/booking/calendar-auth.test.ts` first with mocked vault/fetch/KV dependencies and assert `refreshAccessToken()` stores only encrypted access-token payloads, not refresh tokens
- [ ] Run `npx tsx --test src/lib/booking/calendar-auth.test.ts`; expected before implementation: module import fails because `calendar-auth.ts` does not exist
- [ ] Use **Google Secret Manager** as the refresh-token vault because the Google Calendar OAuth stack already depends on Google IAM. If Google Secret Manager is unavailable, record an architecture decision before substituting HashiCorp Vault or AWS Secrets Manager.
- [ ] Create `src/lib/booking/calendar-auth.ts`:
  - `refreshAccessToken()` fetches refresh token from vault
  - Calls Google OAuth token endpoint
  - Encrypts access token with AES-256-GCM
  - Stores `{ ciphertext, expiresAt }` in KV
- [ ] Update `src/app/api/booking/oauth/callback/route.ts`:
  - Send refresh token to vault instead of KV
  - Store only encrypted access token in KV
- [ ] Update `src/lib/booking/operational-store.ts`:
  - Remove plaintext refresh token storage
  - Add encrypt/decrypt wrapper for access token
- [ ] Create cron route `src/app/api/cron/token-refresh/route.ts`:
  - Runs every 30 minutes
  - Refreshes access token if expiry within 10 minutes
  - Protected by `CRON_SECRET`
- [ ] Add `CALENDAR_TOKEN_ENCRYPTION_KEY` to env vars (32-byte hex)
- [ ] Run `npx tsx --test src/lib/booking/calendar-auth.test.ts`; expected after implementation: test passes
- [ ] Verify: `redis-cli GET booking:calendar-refresh-token` returns nil

#### Task 2.5: Set up Renovate and CI audit gate

- [ ] Create `.github/renovate.json`:
  - Extends `config:recommended`
  - Auto-merge patch updates
  - Group minor updates into weekly PR
  - Block major updates (require human review)
- [ ] Install Renovate GitHub App on repository
- [ ] Update `.github/workflows/ci.yml`:
  - Add `audit` job running `npm audit --audit-level=moderate`
  - Job fails if audit returns findings
- [ ] Validate Renovate config with `npx --yes renovate-config-validator .github/renovate.json`; expected after configuration: validator exits 0
- [ ] Validate audit gate locally with `npm audit --audit-level=moderate`; expected after dependency remediation: exits 0
- [ ] Add `overrides` to `package.json` for known vulnerable chains:
  - `esbuild >= 0.25.0`
  - `postcss >= 8.5.0`
  - `uuid >= 11.0.0`
- [ ] Verify: Renovate dashboard shows open PRs; CI audit job fails on synthetic vulnerable package

---

## Verification Commands

```bash
# Build
npm run build

# Lint
npm run lint

# Unit tests
npm run test:unit

# E2E tests
npm test

# Security header check
curl -I http://localhost:3000/

# Rate limit test
for i in {1..12}; do
  curl -X POST http://localhost:3000/api/checkout \
    -H "Content-Type: application/json" \
    -d '{"test":true}'
done
# Expect: last 2 return 429

# Payload guard test
curl -X POST http://localhost:3000/api/booking/holds \
  -H "Content-Length: 70000" \
  -d '{}'
# Expect: 413

# Secret scan
detect-secrets scan --all-files

# Audit
npm audit --audit-level=moderate
```

---

## Rollout Gates

| Gate | Criteria                                                                                      | Owner         |
| ---- | --------------------------------------------------------------------------------------------- | ------------- |
| G1   | All baseline commands pass (`npm run lint`, `npm run test:unit`, `npm run build`, `npm test`) | Backend dev   |
| G2   | Security headers present on staging HTML responses                                            | Backend dev   |
| G3   | Rate limiter enforces limits without breaking legitimate checkout flow                        | Backend dev   |
| G4   | CSP report-only mode runs for 1 week with < 10 violations/day                                 | Security lead |
| G5   | Calendar sync works after token vault migration                                               | Backend dev   |
| G6   | Renovate opens first PR and CI audit gate passes                                              | DevOps        |

---

## Notes and Cautions

1. **Middleware Edge Runtime**: `src/middleware.ts` runs in Vercel Edge Runtime. Use Web Crypto API (`crypto.subtle`) instead of Node.js `crypto` module.
2. **CSP Nonce Propagation**: Next.js App Router does not automatically pass middleware headers to layouts. Use a custom header (`X-CSP-Nonce`) and read it in layout via `headers()` from `next/headers`.
3. **Rate Limiter Graceful Degradation**: If KV is down, the checkout flow must not break. Log a warning and allow the request. Monitor KV uptime.
4. **Token Vault IAM**: Google Secret Manager requires a service account with `roles/secretmanager.secretAccessor`. Store the service account key in Vercel env vars, never in repo.
5. **Renovate Auto-Merge**: Do not enable auto-merge for minor updates until the test suite has proven reliability for 4+ weeks.
6. **CSP Report-Only Phase**: Keep report-only for at least 2 weeks in staging before enforcing in production. Monitor the reporting endpoint daily.
7. **Link Resolver Audit**: The `scripts/audit-cms-links.ts` script is required; CI must fail if it finds unresolved or unsafe links. Ensure the script runs after `npm run build` and before E2E in the CI job order.
