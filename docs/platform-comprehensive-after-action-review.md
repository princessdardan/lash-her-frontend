# Platform Comprehensive After Action Review

**Date**: 2026-06-05
**Platform**: Lash Her by Nataliea
**Review Type**: Security & Technical Audit
**Severity**: CRITICAL

---

## Executive Summary

The Lash Her Next.js 16 application is a production e-commerce and booking platform with a Sanity CMS backend, PostgreSQL private-data store, Square/Helcim payment integrations, and Google Calendar synchronization. The codebase shows mature patterns in some areas (unit test coverage, build stability, schema structure) but exhibits critical gaps in runtime security, observability, CI/CD discipline, and defense-in-depth controls.

**Overall Score**: 4.2 / 10

| Category       | Score  | Severity |
| -------------- | ------ | -------- |
| Security       | 3 / 10 | CRITICAL |
| Architecture   | 4 / 10 | HIGH     |
| Performance    | 4 / 10 | HIGH     |
| Accessibility  | 3 / 10 | CRITICAL |
| DevOps         | 2 / 10 | CRITICAL |
| Testing        | 4 / 10 | HIGH     |
| Best Practices | 5 / 10 | MEDIUM   |

**Critical Issues (immediate action required)**:

1. No centralized security headers or Content-Security-Policy
2. Public API endpoints lack durable abuse controls (rate limiting is in-memory only)
3. No CI/CD pipeline or automated quality gates
4. Google Calendar refresh token stored in plaintext KV
5. CMS link sanitization is inconsistent and trust-based
6. Accessibility gaps in core interactive components (carousel, popup, booking flow)
7. Dependency chain carries 22 moderate vulnerabilities

**High Issues**:

1. Payment side effects inline on user-facing paths
2. Postgres connection pool lacks serverless-aware limits
3. Global calendar lock serializes booking finalization
4. Heavy client components mounted on every page in site shell
5. No structured observability (Sentry, OTel, or alerting)
6. Test coverage not instrumented; lint warnings persist
7. Build artifacts include a 4.2 MB chunk and 8.9 MB total static assets

---

## Initial Discovery and Project Structure Analysis

### Directory Map

```
/Users/dardan/workspace/lash-her-frontend/
├── README.md                          # App description, path map, commands
├── package.json                       # Scripts and dependencies
├── next.config.ts                     # React Compiler, redirects, image patterns
├── vercel.json                        # Cron job config only
├── .gitignore                         # Ignores env files, tarballs, playwright logs
├── .env.local                         # Present; contains secret-bearing names
├── src/
│   ├── app/                           # 79 files; routes, API handlers, layouts
│   │   ├── (site)/                    # Public site pages
│   │   ├── api/                       # API routes (checkout, booking, webhooks)
│   │   ├── layout.tsx                 # Root layout (SpeedInsights always loaded)
│   │   └── (site)/layout.tsx          # Site shell (contact popup, cart, analytics)
│   ├── components/                    # 68 files; UI primitives + custom layouts
│   │   ├── ui/                        # shadcn/ui base + SanityImage, portable text
│   │   ├── custom/layouts/            # Block renderer, hero carousel, feature sections
│   │   └── custom/                    # Training items, contact popup, booking flow
│   ├── lib/                           # 115 files; DB, booking, commerce, validation
│   │   ├── private-db/                # Drizzle client, pool config, schema
│   │   ├── booking/                   # Operational store (KV), calendar lock
│   │   ├── commerce/                  # Checkout validation, cart storage
│   │   └── form-validation.ts         # Shared validation utilities
│   ├── sanity/                        # 49 files; schemas, client, write-client
│   │   ├── schemas/                   # Document schemas (product, service, hero)
│   │   └── lib/                       # Read client, write client, GROQ loaders
│   └── types/index.ts                 # CMS block TypeScript unions
├── tests/                             # Playwright E2E specs
├── docs/                              # Launch readiness, production cutover
└── scripts/                           # Validation, migration scripts
```

### Tech Stack

| Layer        | Technology                        | Version / Notes                                   |
| ------------ | --------------------------------- | ------------------------------------------------- |
| Framework    | Next.js                           | 16.1.6 (16.2.6 at build time)                     |
| React        | React                             | 18 (React Compiler enabled)                       |
| Styling      | Tailwind CSS                      | v4 (CSS-first, `@theme` in globals.css)           |
| CMS          | Sanity                            | project `3auncj84`, API `2026-03-24`              |
| Database     | PostgreSQL                        | via `pg` + Drizzle ORM                            |
| Payments     | Square + Helcim                   | Square for services; Helcim for products/training |
| Email        | Resend                            | -                                                 |
| KV / Locking | Vercel KV (Redis)                 | Calendar lock, OAuth tokens                       |
| Analytics    | Vercel Analytics + Speed Insights | SpeedInsights always loaded                       |
| Animation    | Motion (Framer Motion successor)  | -                                                 |
| Testing      | Node test runner + Playwright     | 614 unit tests, 27 suites                         |

### Commands Run During Discovery

```
npm audit                    # 22 moderate vulnerabilities
npm run lint                 # 0 errors, 7 warnings
npm run test:unit            # PASS, 614 tests, 27 suites, 0 failed, ~32s
npm run build                # PASS; static assets ~8,917,638 bytes
```

### Git Hygiene

- **Tracked files**: 425 total
- **Notable tracked artifacts**: `.playwright-mcp/` console and page logs (present in index despite `.gitignore:58-61` adding the ignore rule)
- **Root tarballs**: `production-pre-cutover-backup.tar.gz`, `staging-approved-cutover.tar.gz` exist in working tree
- **No `.github/` directory**: zero CI/CD workflow files

---

## 1. Security Analysis - Score: 3/10 🔒

### Issue 1.1: Public endpoints lack durable abuse controls

**Evidence**:

- `src/app/api/checkout/route.ts:180-207` — creates provider artifacts (Helcim) before a durable pending order exists.
- `src/app/api/training-checkout/route.ts:146-198` — same pattern for training enrollment checkout.
- `src/app/api/booking/checkout/route.ts:52-80` — booking checkout creates Square checkout without durable abuse controls.
- `src/app/api/booking/holds/route.ts:86-100` and `:203-209` — parses and creates booking holds with no rate limiting.
- `src/app/actions/form.ts:57-74` — rate limiter is in-memory (`Map` per serverless instance). This evaporates on every cold start and provides no cross-instance protection.

**Good Solution - Per-Route In-Memory Limiter with IP Buckets**

**Implementation**: Replace the naive `Map` in `src/app/actions/form.ts` with a per-request in-memory sliding window using `X-Forwarded-For` or `X-Real-IP`.

**Components**:

1. New helper `src/lib/security/rate-limiter.ts` with a `Map<string, number[]>` keyed by IP.
2. Middleware function `isRateLimited(ip, windowMs, maxRequests)` that prunes old timestamps.
3. Wrap each public POST handler with the helper.

**Code Example**:

```typescript
// src/lib/security/rate-limiter.ts
const buckets = new Map<string, number[]>();

export function isRateLimited(
  key: string,
  windowMs: number = 60000,
  maxRequests: number = 10,
): boolean {
  const now = Date.now();
  const timestamps = buckets.get(key) ?? [];
  const windowStart = now - windowMs;
  const recent = timestamps.filter((t) => t > windowStart);

  if (recent.length >= maxRequests) {
    buckets.set(key, recent);
    return true;
  }

  recent.push(now);
  buckets.set(key, recent);
  return false;
}
```

**Expected Results**: Slightly better abuse resistance within a single serverless instance. Still useless against distributed attacks or cold starts.

**Pros**: Zero new dependencies; fast to implement.
**Cons**: No cross-instance coordination; trivial to bypass by forcing cold starts.

---

**Better Solution - Upstash Redis Token Bucket**

**Implementation**: Use the existing `@upstash/redis` dependency to store rate-limit counters in Redis with TTL.

**Components**:

1. New helper `src/lib/security/kv-rate-limiter.ts` using `@upstash/redis`.
2. Token-bucket algorithm with `INCR` and `EXPIRE` for per-IP and per-route keys.
3. Standardize across `src/app/api/checkout/route.ts`, `src/app/api/booking/holds/route.ts`, and `src/app/actions/form.ts`.

**Code Example**:

```typescript
// src/lib/security/kv-rate-limiter.ts
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

export async function checkKvRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ limited: boolean; remaining: number }> {
  const pipeline = redis.pipeline();
  pipeline.incr(key);
  pipeline.expire(key, windowSeconds);
  const [count] = (await pipeline.exec()) as [number];

  return {
    limited: count > limit,
    remaining: Math.max(0, limit - count),
  };
}
```

**Expected Results**: Durable, cross-instance rate limiting that survives cold starts. Abuse thresholds become real.

**Pros**: Uses existing infrastructure; works across all serverless instances.
**Cons**: Adds KV latency to every public POST; must handle KV unavailability gracefully.

---

**Best Solution - Layered Defense with Edge Rate Limiting and Signed Nonces**

**Implementation**: Combine Upstash Redis token buckets with signed session nonces, IP reputation heuristics, and per-route tiered limits.

**Components**:

1. `src/middleware.ts` — lightweight edge middleware that rejects obvious abuse (missing UA, bot patterns) and sets a signed `__session` nonce.
2. `src/lib/security/kv-rate-limiter.ts` — enhanced with IP + route + nonce composite keys.
3. `src/lib/security/request-signer.ts` — HMAC-signed payload nonces for checkout/booking holds to prevent replay.
4. Per-route limits: checkout/booking (strict), form/contact (moderate), revalidate/webhook (IP-allowlist only).

**Code Example**:

```typescript
// src/middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const ua = request.headers.get("user-agent") ?? "";
  if (!ua || ua.length < 10) {
    return new NextResponse("Bad Request", { status: 400 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/api/checkout/:path*",
    "/api/booking/:path*",
    "/api/training-checkout",
  ],
};
```

**Expected Results**: Abuse is blocked at the edge before it reaches business logic. Replay attacks are impossible. Rate limits are granular and observable.

**Pros**: Defense in depth; edge-level rejection is cheapest; signed nonces prevent replay.
**Cons**: Requires careful middleware configuration; more complex to test.

---

### Issue 1.2: Missing centralized security headers / Content-Security-Policy

**Evidence**:

- `next.config.ts:3-28` — contains React Compiler, redirects, and `images.remotePatterns`; no `headers()` config.
- `vercel.json:1-8` — only a cron job definition; no headers.
- Directory search: no `src/middleware.ts` file exists in the project.

**Good Solution - Add Static Headers in next.config.ts**

**Implementation**: Add a `headers()` async function to `next.config.ts` that injects basic security headers for all routes.

**Components**:

1. Modify `next.config.ts` to export `headers`.
2. Define a static header array for `source: "/:path*"`.

**Code Example**:

```typescript
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.sanity.io; connect-src 'self'; frame-ancestors 'none'; base-uri 'self';",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
```

**Expected Results**: Browsers receive baseline CSP and security headers on all routes. Some inline scripts/styles may need nonce relaxation.

**Pros**: Immediate deployment; zero dependencies.
**Cons**: Static CSP is brittle; `unsafe-inline` weakens protection; hard to maintain as domains change.

---

**Better Solution - Middleware-Based Headers with Strict CSP and Nonces**

**Implementation**: Create `src/middleware.ts` to generate per-request CSP nonces and inject strict headers.

**Components**:

1. `src/middleware.ts` — generates `script-src 'nonce-xxx'` and `style-src 'nonce-xxx'` per request.
2. Pass nonce via request headers to layout so inline scripts/styles can reference it.
3. Keep `next.config.ts` headers as a fallback for static assets.

**Code Example**:

```typescript
// src/middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function generateNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array));
}

export function middleware(request: NextRequest) {
  const nonce = generateNonce();
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: https://cdn.sanity.io",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join("; ");

  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-CSP-Nonce", nonce);

  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
```

**Expected Results**: Each HTML response carries a unique CSP nonce. Inline scripts must match the nonce or they are blocked.

**Pros**: Stronger CSP; nonces prevent most XSS vectors.
**Cons**: Requires every inline script/style to read the nonce; third-party scripts may break.

---

**Best Solution - Enterprise-Grade Header Policy with Report-Only Phasing, Report-URI, and Strict-Transport-Security**

**Implementation**: Implement a staged CSP rollout with reporting, HSTS preload readiness, and per-environment configuration.

**Components**:

1. `src/lib/security/csp-policy.ts` — environment-aware CSP builder with report-only mode.
2. `src/middleware.ts` — injects headers with nonces and report-to endpoints.
3. Add `report-to` and `Content-Security-Policy-Report-Only` headers for staging.
4. Configure `Strict-Transport-Security` with `max-age=63072000; includeSubDomains; preload` for production.
5. Add `Permissions-Policy` to disable unused browser APIs (camera, microphone, geolocation).

**Code Example**:

```typescript
// src/lib/security/csp-policy.ts
export function buildCsp(
  nonce: string,
  env: "development" | "production" = "production",
) {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: https://cdn.sanity.io",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ];

  if (env === "production") {
    directives.push("report-to csp-endpoint");
  }

  return directives.join("; ");
}
```

**Expected Results**: Production gets a hardened CSP with reporting. Staging can run report-only to catch violations before enforcement. HSTS preloading is possible.

**Pros**: Industry-standard defense; violation reports reveal real-world issues before enforcement.
**Cons**: Requires a reporting endpoint; report-only phase must be actively monitored.

---

### Issue 1.3: CMS-authored link sanitization is inconsistent

**Evidence**:

- `src/app/main-menu.tsx:14-16` and `:59-61` — passes CMS `href` directly into Next.js `Link` without validation.
- `src/components/ui/portable-text-renderer.tsx:24-31` — uses `value?.href` directly for anchor tags.
- `src/components/custom/layouts/feature-section.tsx:79` and `:145-156` — uses resolved CMS link directly in `Link` or `<a>`.
- Positive: `src/components/custom/layouts/hero-links.ts:3-18` has a `safeProtocol` helper (`http:`, `https:`, `mailto:`, `tel:`), but it is not centralized or reused elsewhere.

**Good Solution - Centralize safeProtocol in a Link Wrapper**

**Implementation**: Extract the existing `safeProtocol` logic into a reusable `<SafeLink>` component and replace direct `href` usage in the three flagged locations.

**Components**:

1. `src/components/ui/safe-link.tsx` — wrapper that validates href against allowed protocols.
2. Replace direct `<Link href={cmsHref}>` and `<a href={value?.href}>` calls with `<SafeLink>`.

**Code Example**:

```typescript
// src/components/ui/safe-link.tsx
import Link from "next/link";

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export function SafeLink({
  href,
  children,
  ...props
}: React.ComponentProps<typeof Link>) {
  const isSafe =
    typeof href === "string" &&
    (href.startsWith("/") || SAFE_PROTOCOLS.has(new URL(href).protocol));

  if (!isSafe) {
    return <span {...props}>{children}</span>;
  }

  return (
    <Link href={href} {...props}>
      {children}
    </Link>
  );
}
```

**Expected Results**: All CMS-driven links are validated at render time. `javascript:` and `data:` URLs are dropped.

**Pros**: Reuses existing logic; low risk of regression.
**Cons**: Only covers React-rendered links; does not prevent malicious CMS input at the source.

---

**Better Solution - Schema-Level + Component-Level Double Validation**

**Implementation**: Add a `url` validation rule to Sanity link fields and enforce the same protocol list in both schema and UI.

**Components**:

1. Sanity schema — add validation to all `url` / `href` / `link` fields in `product.ts`, `service.ts`, `hero-section.ts`, and custom block types.
2. `src/components/ui/safe-link.tsx` — component-level enforcement as above.
3. `src/lib/cms-link-validation.ts` — shared validation function used by both schema and UI.

**Code Example**:

```typescript
// src/lib/cms-link-validation.ts
export const ALLOWED_PROTOCOLS = ["http:", "https:", "mailto:", "tel:"];

export function isValidCmsLink(href: string | undefined): boolean {
  if (!href) return false;
  if (href.startsWith("/")) return true;
  try {
    return ALLOWED_PROTOCOLS.includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

// In a Sanity schema file
import { isValidCmsLink } from "@/lib/cms-link-validation";

{
  name: "ctaUrl",
  type: "url",
  validation: (Rule) =>
    Rule.custom((value) =>
      isValidCmsLink(value) ? true : "Invalid link protocol or format"
    ),
}
```

**Expected Results**: Invalid links are rejected at CMS edit time and also sanitized at render time.

**Pros**: Defense in depth; editors get immediate feedback.
**Cons**: Requires updating multiple schemas; custom validation logic must be kept in sync.

---

**Best Solution - Link Resolution Service with Strict Schema, Component Enforcement, and Audit Logging**

**Implementation**: Treat all CMS links as untrusted by default. Resolve them through a strict service that logs violations and provides fallback behavior.

**Components**:

1. `src/lib/cms-link-resolver.ts` — resolves CMS link objects to validated URLs with a strict allowlist.
2. `src/components/ui/safe-link.tsx` — uses the resolver; renders a warning in dev/staging when an invalid link is encountered.
3. Sanity schema — marks link fields as required with strict regex/protocol validation.
4. Build-time step or lint rule that audits all GROQ projections for unvalidated `href` fields.

**Code Example**:

```typescript
// src/lib/cms-link-resolver.ts
import { isValidCmsLink } from "@/lib/cms-link-validation";

export interface ResolvedLink {
  href: string;
  isExternal: boolean;
  isSafe: boolean;
}

export function resolveCmsLink(raw: unknown): ResolvedLink {
  const href = typeof raw === "string" ? raw : "";
  const safe = isValidCmsLink(href);

  if (!safe && process.env.NODE_ENV !== "production") {
    console.warn(`[CMS Link Resolver] Rejected unsafe link: ${href}`);
  }

  return {
    href: safe ? href : "#",
    isExternal: safe && (href.startsWith("http") || href.startsWith("mailto")),
    isSafe: safe,
  };
}
```

**Expected Results**: Unsafe links are never rendered as clickable. Violations are visible in staging logs. The allowlist is a single source of truth.

**Pros**: Centralized control; observable; prevents accidental editorial XSS.
**Cons**: More code to maintain; requires discipline to route all links through the resolver.

---

### Issue 1.4: Google Calendar refresh token stored in KV plaintext

**Evidence**:

- `src/app/api/booking/oauth/callback/route.ts:23-33` — stores the refresh token in KV after OAuth callback.
- `src/lib/booking/operational-store.ts:7` and `:31-37` — defines and implements `storeCalendarToken(refreshToken)` using the KV client directly with no encryption.

**Good Solution - Encrypt at Rest with AES-256-GCM**

**Implementation**: Encrypt the refresh token before storing it in KV, using a dedicated encryption key (not the checkout encryption key).

**Components**:

1. New env var `CALENDAR_TOKEN_ENCRYPTION_KEY` (32-byte hex).
2. `src/lib/security/token-crypto.ts` — `encryptToken(plaintext)` and `decryptToken(ciphertext)` with AES-256-GCM.
3. Update `operational-store.ts:31-37` to encrypt before `kv.set` and decrypt after `kv.get`.

**Code Example**:

```typescript
// src/lib/security/token-crypto.ts
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";

const ALGO = "aes-256-gcm";
const KEY = scryptSync(
  process.env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? "",
  "calendar-salt",
  32,
);

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptToken(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, 16);
  const authTag = buf.subarray(16, 32);
  const encrypted = buf.subarray(32);
  const decipher = createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}
```

**Expected Results**: KV contains only ciphertext. A KV breach does not expose the refresh token.

**Pros**: Simple; uses Node.js built-ins; no new dependencies.
**Cons**: Key rotation is manual; key must be backed up securely.

---

**Better Solution - Encrypt Plus Hash for Integrity Checks**

**Implementation**: Same as Good, but also store a SHA-256 hash of the plaintext to detect tampering or accidental corruption.

**Components**:

1. `src/lib/security/token-crypto.ts` — add `hashToken` function.
2. Store `{ ciphertext, hash }` as JSON in KV.
3. On retrieval, re-hash the decrypted value and compare.

**Code Example**:

```typescript
// src/lib/security/token-crypto.ts
import { createHash } from "crypto";

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

// In operational-store.ts
export async function storeCalendarToken(refreshToken: string) {
  const ciphertext = encryptToken(refreshToken);
  const hash = hashToken(refreshToken);
  await kv.set(CALENDAR_TOKEN_KEY, JSON.stringify({ ciphertext, hash }));
}
```

**Expected Results**: Tampered or corrupted tokens are detected at decryption time.

**Pros**: Detects accidental KV corruption; simple to implement.
**Cons**: Hash does not add cryptographic security; still vulnerable to key compromise.

---

**Best Solution - Rotate Short-Lived Access Tokens and Move Refresh Token to HSM/Vault**

**Implementation**: Do not store the refresh token in KV at all. Use it once to obtain an access token, store only the short-lived access token, and implement a background refresh job that re-authenticates when needed.

**Components**:

1. `src/lib/booking/calendar-auth.ts` — handles the OAuth flow and refreshes the access token using a secure token vault or HSM.
2. `src/app/api/booking/oauth/callback/route.ts:23-33` — sends the refresh token to a secure vault (e.g., HashiCorp Vault, AWS Secrets Manager, or Google Secret Manager) instead of KV.
3. Background cron or on-demand refresh that fetches the refresh token from the vault, gets a new access token, and stores only the access token (encrypted) in KV.
4. KV stores only `{ accessToken: encrypted, expiresAt: timestamp }`.

**Code Example**:

```typescript
// src/lib/booking/calendar-auth.ts
export async function refreshAccessToken(): Promise<string> {
  // Fetch refresh token from secure vault, not KV
  const refreshToken = await secureVault.get("google-calendar-refresh-token");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await response.json();
  const accessToken = data.access_token;
  const expiresAt = Date.now() + data.expires_in * 1000;

  await kv.set(
    "booking:calendar-access-token",
    JSON.stringify({
      ciphertext: encryptToken(accessToken),
      expiresAt,
    }),
  );

  return accessToken;
}
```

**Expected Results**: The long-lived refresh token is never in application storage. KV contains only short-lived, encrypted access tokens.

**Pros**: Gold standard; limits blast radius of any single breach.
**Cons**: Requires external vault integration; more infrastructure to manage.

---

### Issue 1.5: Input payload size / string / array limits inconsistent

**Evidence**:

- `src/app/api/booking/holds/route.ts:86-100` and `:296-350` — parses hold requests with no explicit size or array-length caps.
- `src/app/actions/form.ts:23-50` — validates required fields and email format only.
- `src/lib/form-validation.ts:1-94` — supports `maxLength` but current form configs do not use it consistently.
- Positive example: `src/lib/commerce/checkout-validation.ts:1-65` has max-length controls for checkout fields.

**Good Solution - Add Max-Length Defaults to Form Validation**

**Implementation**: Update `src/lib/form-validation.ts` to enforce sensible defaults (e.g., 255 chars for strings, 10 items for arrays) when maxLength is not explicitly provided.

**Components**:

1. Modify `src/lib/form-validation.ts` to add default `maxLength` rules.
2. Update `src/app/actions/form.ts:23-50` to apply the defaults.

**Code Example**:

```typescript
// src/lib/form-validation.ts
export const DEFAULT_MAX_LENGTHS = {
  string: 255,
  email: 254,
  message: 2000,
  array: 10,
};

export interface ValidationRules {
  required?: boolean;
  email?: boolean;
  maxLength?: number;
}

export function validateField(
  value: unknown,
  rules: ValidationRules,
): string | undefined {
  if (
    rules.required &&
    (value === undefined || value === null || value === "")
  ) {
    return "This field is required";
  }
  if (rules.email && typeof value === "string" && !value.includes("@")) {
    return "Invalid email address";
  }
  if (rules.maxLength && String(value).length > rules.maxLength) {
    return `Must be at most ${rules.maxLength} characters`;
  }
  if (
    !rules.maxLength &&
    typeof value === "string" &&
    value.length > DEFAULT_MAX_LENGTHS.string
  ) {
    return `Must be at most ${DEFAULT_MAX_LENGTHS.string} characters`;
  }
  return undefined;
}
```

**Expected Results**: All form fields have implicit length caps. Oversized payloads are rejected early.

**Pros**: Low effort; consistent with existing validation pattern.
**Cons**: Does not cover API routes directly; only helps form actions.

---

**Better Solution - Validate Payload Size and Shape at API Boundary**

**Implementation**: Add explicit `content-length` checks and Zod/object-schema validation to `booking/holds`, `checkout`, and `training-checkout` routes.

**Components**:

1. `src/lib/security/payload-guard.ts` — checks `Content-Length` header against a max bytes limit and validates body shape with Zod.
2. Apply to `src/app/api/booking/holds/route.ts`, `src/app/api/checkout/route.ts`, and `src/app/api/training-checkout/route.ts`.

**Code Example**:

```typescript
// src/lib/security/payload-guard.ts
import { NextRequest } from "next/server";

const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB

export function assertPayloadSize(request: NextRequest): void {
  const length = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (length > MAX_PAYLOAD_BYTES) {
    throw new Error("Payload too large");
  }
}
```

**Expected Results**: API routes reject oversized or malformed payloads before entering business logic.

**Pros**: Protects all public POST endpoints; explicit and observable.
**Cons**: Requires Zod schema maintenance for each route.

---

**Best Solution - Global Request Interceptor with Size, Shape, and Depth Limits**

**Implementation**: Introduce a middleware or route-wrapper that enforces global limits on all API routes: max body size, max array depth, max string length, and max object keys.

**Components**:

1. `src/lib/security/request-guard.ts` — comprehensive guard with configurable per-route overrides.
2. `src/middleware.ts` or HOF wrapper `withRequestGuard(handler, options)` applied to every API route.
3. Logging of rejected payloads for abuse analysis.

**Code Example**:

```typescript
// src/lib/security/request-guard.ts
import { NextRequest } from "next/server";

export interface GuardOptions {
  maxBytes?: number;
  maxStringLength?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
}

function assertPayloadSize(request: NextRequest, maxBytes: number): void {
  const length = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (length > maxBytes) {
    throw new Error("Payload too large");
  }
}

export async function guardRequest(
  request: NextRequest,
  options: GuardOptions = {},
): Promise<unknown> {
  const opts = {
    maxBytes: 65536,
    maxStringLength: 1024,
    maxArrayLength: 50,
    ...options,
  };
  assertPayloadSize(request, opts.maxBytes);
  const body = await request.json();
  // assertDepthLimits would recursively validate body against opts
  return body;
}
```

**Expected Results**: A single policy governs all public APIs. Abuse patterns are logged.

**Pros**: Centralized; maintainable; covers edge cases like deeply nested JSON bombs.
**Cons**: More initial setup; must not break legitimate large payloads.

---

### Issue 1.6: Dependency vulnerabilities from npm audit

**Evidence**:

- `npm audit` reports 22 moderate vulnerabilities originating from dependency chains in `package.json:24-75`.

**Good Solution - Update Patch-Level Versions**

**Implementation**: Run `npm audit fix` to apply non-breaking patch and minor updates.

**Components**:

1. `npm audit fix`.
2. Re-run `npm run build` and `npm run test:unit` to verify.

**Code Example**:

```shell
npm audit fix
npm run build
npm run test:unit
```

**Expected Results**: Some vulnerabilities are resolved automatically.

**Pros**: Fast; low risk.
**Cons**: May not resolve all 22; some chains require major version bumps.

---

**Better Solution - Pin Resolutions and Audit in CI**

**Implementation**: Add `overrides` in `package.json` for known vulnerable sub-dependencies and enforce `npm audit --audit-level=moderate` in a pre-commit or local check.

**Components**:

1. `package.json` `"overrides"` section for `esbuild`, `postcss`, `uuid`.
2. Local git hook or script that blocks commit on audit failures.

**Code Example**:
// package.json

```json
{
  "overrides": {
    "esbuild": ">=0.25.0",
    "postcss": ">=8.5.0",
    "uuid": ">=11.0.0"
  }
}
```

**Expected Results**: Vulnerable transitive dependencies are overridden at install time.

**Pros**: Immediate mitigation without waiting for upstream.
**Cons**: May introduce incompatibilities; must be tested.

---

**Best Solution - Automated Dependency Management with Renovate + CI Gate**

**Implementation**: Introduce Renovate or Dependabot with auto-merge for patch updates, plus a CI job that fails on `npm audit` moderate+ findings.

**Components**:

1. `.github/renovate.json` or Dependabot config.
2. GitHub Actions workflow running `npm audit --audit-level=moderate` on PR.
3. Recurring manual review for major updates.

**Code Example**:
// .github/renovate.json

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "packageRules": [
    {
      "matchUpdateTypes": ["patch", "minor"],
      "automerge": true
    }
  ]
}
```

**Expected Results**: Vulnerabilities are patched automatically. CI prevents merging known vulnerable code.

**Pros**: Sustainable; zero manual toil for patches.
**Cons**: Requires CI infrastructure; auto-merge requires trust in test suite.

---

### Issue 1.7: Local secret hygiene risk

**Evidence**:

- `.gitignore:8-11` ignores env files (`*.env*`, `.env.local`, `.env.*.local`).
- `.env.local` exists in the working tree with secret-bearing names.
- Secret names observed include: `SANITY_WRITE_TOKEN`, `SANITY_API_READ_TOKEN`, `RESEND_API_KEY`, `GOOGLE_CLIENT_SECRET`, `KV_REST_API_TOKEN`, `DATABASE_URL`, `SQUARE_ACCESS_TOKEN`, `HELCIM_GENERAL_API_TOKEN`, `CHECKOUT_SECRET_ENCRYPTION_KEY`, `CRON_SECRET`, `EMAIL_RETRY_SECRET`.

**Good Solution - Verify .env.local is Ignored and Document Secret Rotation**

**Implementation**: Confirm `.env.local` is not tracked, document the secret inventory, and add a `SECURITY.md` note about rotation procedures.

**Components**:

1. `git rm --cached .env.local` if accidentally tracked.
2. `docs/secrets-inventory.md` — list of secret names, purpose, and rotation contacts.

**Code Example**:

```shell
# Ensure .env.local is not tracked
git rm --cached .env.local 2>/dev/null || true

# Verify ignore status
git check-ignore -v .env.local
```

**Expected Results**: No secrets in git history going forward. Team knows what exists and how to rotate.

**Pros**: Immediate hygiene improvement.
**Cons**: Does not detect leaks that already happened.

---

**Better Solution - Add Secret Scanning and Pre-Commit Hooks**

**Implementation**: Install `detect-secrets` or `git-secrets` and a pre-commit hook that blocks commits containing high-entropy strings matching known secret patterns.

**Components**:

1. `detect-secrets` baseline scan.
2. `.pre-commit-config.yaml` or local husky hook.
3. `.gitallowed` file for false positives.

**Code Example**:

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/Yelp/detect-secrets
    rev: v1.5.0
    hooks:
      - id: detect-secrets
        args: ["--baseline", ".secrets.baseline"]
```

**Expected Results**: Accidental commits of `.env.local` or secret strings are blocked.

**Pros**: Catches human error.
**Cons**: Requires team discipline to install hooks.

---

**Best Solution - Move All Secrets to a Vault and Rotate on Schedule**

**Implementation**: Never store production secrets in `.env.local`. Use a secrets manager (Vercel environment variables UI is acceptable for Vercel deploys, but local dev should use a vault or 1Password CLI).

**Components**:

1. Delete `.env.local` from all developer machines.
2. Use `op run --` (1Password) or `doppler run` for local dev injection.
3. Regular rotation schedule documented in `docs/security-runbook.md`.
4. Audit log of who has accessed which secrets.

**Code Example**:

```shell
# 1Password CLI example for local development
op run --env-file=.env.local.template -- npm run dev
```

**Expected Results**: Secrets are never on disk in plaintext. Rotation is routine.

**Pros**: Industry standard; minimal blast radius if a laptop is compromised.
**Cons**: Workflow friction; requires subscription to a secrets manager.

---

## 2. Architecture Analysis - Score: 4/10 🏗️

### Issue 2.1: External provider artifacts are created before durable pending order

**Evidence**:

- `src/app/api/checkout/route.ts:180-207` — creates Helcim checkout session before writing a pending order to PostgreSQL.
- `src/app/api/training-checkout/route.ts:146-198` — same pattern for training enrollment.

**Good Solution - Write Pending Order Before Provider Call**

**Implementation**: Swap the order: insert a `pending` order record into PostgreSQL first, then call the payment provider with the order ID as metadata.

**Components**:

1. Reorder logic in `src/app/api/checkout/route.ts` and `src/app/api/training-checkout/route.ts`.
2. Ensure the pending order row has a `providerSessionId` nullable field that is updated after the provider responds.

**Code Example**:

```typescript
// In src/app/api/checkout/route.ts
const pendingOrder = await db
  .insert(orders)
  .values({
    status: "pending",
    total: calculatedTotal,
    items: JSON.stringify(cartItems),
    createdAt: new Date(),
  })
  .returning();

const session = await helcim.createCheckoutSession({
  ...payload,
  metadata: { orderId: pendingOrder[0].id },
});

await db
  .update(orders)
  .set({ providerSessionId: session.id })
  .where(eq(orders.id, pendingOrder[0].id));
```

**Expected Results**: Every provider session is backed by a durable order record.

**Pros**: Simple reorder; no new dependencies.
**Cons**: Does not handle the case where the provider call fails after the DB write; requires cleanup job.

---

**Better Solution - Two-Phase Commit with Idempotency Key**

**Implementation**: Generate an idempotency key (UUID), write a `pending` order with that key, then call the provider with the same key. On retry, skip the provider call if the order already has a `providerSessionId`.

**Components**:

1. `src/lib/commerce/order-service.ts` — `createPendingOrder(idempotencyKey)`.
2. Provider calls include `Idempotency-Key` header.
3. Checkout route checks for existing order before creating a new one.

**Code Example**:

```typescript
// In checkout route
import { eq } from "drizzle-orm";

const idempotencyKey = crypto.randomUUID();

const existing = await db.query.orders.findFirst({
  where: eq(orders.idempotencyKey, idempotencyKey),
});

if (existing?.providerSessionId) {
  return Response.json({ checkoutUrl: existing.checkoutUrl });
}

const pendingOrder = await createPendingOrder({ idempotencyKey, items, total });
const session = await helcim.createCheckoutSession({
  ...payload,
  idempotencyKey,
  metadata: { orderId: pendingOrder.id },
});

await db
  .update(orders)
  .set({ providerSessionId: session.id })
  .where(eq(orders.id, pendingOrder.id));
```

**Expected Results**: Duplicate requests are harmless. Provider sessions are idempotent.

**Pros**: Prevents double-charge; handles retries safely.
**Cons**: Requires provider support for idempotency keys.

---

**Best Solution - Outbox Pattern with Background Worker**

**Implementation**: Write a `pending` order and an `outbox` event to PostgreSQL in a single transaction. A background worker (or Vercel cron) reads the outbox and calls the provider. The checkout route only writes to the DB and returns a poll URL.

**Components**:

1. `outbox` table: `id, type, payload, status, createdAt, processedAt`.
2. Checkout route writes to `orders` and `outbox` in a Drizzle transaction.
3. Background worker polls `outbox` where `status = 'pending'`.
4. Worker updates order with provider session ID and marks outbox as `processed`.

**Code Example**:

```typescript
// src/lib/commerce/outbox.ts
import { db } from "@/lib/private-db/client";
import { outbox } from "@/lib/private-db/schema";
import { eq } from "drizzle-orm";

export async function enqueueOutbox(type: string, payload: unknown) {
  await db.insert(outbox).values({
    type,
    payload: JSON.stringify(payload),
    status: "pending",
    createdAt: new Date(),
  });
}

export async function pollPendingOutbox() {
  return db.select().from(outbox).where(eq(outbox.status, "pending"));
}
```

**Expected Results**: Checkout route is fast and durable. Provider failures are retried automatically.

**Pros**: Full decoupling; checkout route is never blocked by provider latency.
**Cons**: Requires background worker infrastructure; adds latency to checkout URL availability.

---

### Issue 2.2: Payment finalization and email/calendar side effects are inline on user/webhook paths

**Evidence**:

- `src/app/api/checkout/validate-payment/route.ts:138-153` and `:223-255` — finalizes payment, sends email, and updates calendar inline in the user-facing validation route.
- `src/app/api/webhooks/card-transactions/route.ts:111-139` — returns HTTP 503 for downstream side-effect failures, causing the provider to retry the webhook and potentially duplicate side effects.

**Good Solution - Return 200 to Webhook Immediately, Queue Side Effects**

**Implementation**: Acknowledge the webhook with 200 immediately, then run side effects asynchronously via `Promise.allSettled` without blocking the response.

**Components**:

1. Modify `card-transactions/route.ts:111-139` to return 200 before side effects.
2. Use `Promise.allSettled` for email + calendar updates.

**Code Example**:

```typescript
// In src/app/api/webhooks/card-transactions/route.ts
export async function POST(request: Request) {
  const payload = await request.json();

  // Validate signature first
  if (!isValidSignature(payload)) {
    return new Response("Invalid signature", { status: 400 });
  }

  // Acknowledge immediately
  const sideEffects = Promise.allSettled([
    sendConfirmationEmail(payload),
    addCalendarEvent(payload),
    updateOrderStatus(payload),
  ]);

  // Do not await side effects before responding
  sideEffects.then((results) => {
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(`Side effect ${index} failed:`, result.reason);
      }
    });
  });

  return new Response("OK", { status: 200 });
}
```

**Expected Results**: Webhook provider sees success and stops retrying. Side effects may still fail but are not retried by the provider.

**Pros**: Prevents webhook retry loops.
**Cons**: Failures are silent; no retry for side effects.

---

**Better Solution - Webhook Ack + Outbox for Side Effects**

**Implementation**: Return 200 immediately, then write side-effect events to an `outbox` table. A background worker processes the outbox.

**Components**:

1. `outbox` table with event types: `send_order_email`, `add_calendar_event`.
2. Webhook handler writes to outbox.
3. Worker processes events with idempotency keys.

**Code Example**:

```typescript
// In webhook handler
export async function POST(request: Request) {
  const payload = await request.json();
  if (!isValidSignature(payload)) {
    return new Response("Invalid signature", { status: 400 });
  }

  await db.insert(outbox).values([
    {
      type: "send_order_email",
      payload: JSON.stringify(payload),
      status: "pending",
    },
    {
      type: "add_calendar_event",
      payload: JSON.stringify(payload),
      status: "pending",
    },
  ]);

  return new Response("OK", { status: 200 });
}
```

**Expected Results**: Side effects are retried reliably without webhook retry loops.

**Pros**: Reliable; observable; idempotent.
**Cons**: Requires worker infrastructure.

---

**Best Solution - Event Sourcing with Idempotent Consumers**

**Implementation**: Treat payment confirmation as a domain event. Publish it to a message bus (or use PostgreSQL `LISTEN/NOTIFY`). Separate microservices or functions consume the event idempotently.

**Components**:

1. `events` table: `id, type, aggregateId, payload, occurredAt`.
2. Publisher in webhook handler.
3. Consumers: `EmailConsumer`, `CalendarConsumer`, `AnalyticsConsumer`.
4. Each consumer tracks processed event IDs to ensure idempotency.

**Code Example**:

```typescript
// src/lib/events/event-store.ts
import { db } from "@/lib/private-db/client";
import { events } from "@/lib/private-db/schema";

export async function publishEvent(
  type: string,
  aggregateId: string,
  payload: unknown,
) {
  await db.insert(events).values({
    type,
    aggregateId,
    payload: JSON.stringify(payload),
    occurredAt: new Date(),
  });
}

export async function processEvent(
  eventId: string,
  handler: () => Promise<void>,
) {
  const alreadyProcessed = await db.query.processedEvents.findFirst({
    where: (table) => eq(table.eventId, eventId),
  });
  if (alreadyProcessed) return;

  await handler();
  await db.insert(processedEvents).values({ eventId, processedAt: new Date() });
}
```

**Expected Results**: Fully decoupled architecture. New side effects can be added without touching the webhook handler.

**Pros**: Scalable; extensible; resilient.
**Cons**: Significant architectural change; requires message bus or polling logic.

---

### Issue 2.3: Global site shell mounts heavy client components on every page

**Evidence**:

- `src/app/(site)/layout.tsx:29-39` — mounts `ContactPopup`, cart sheet, product provider, and other client components on every public page.
- `src/components/custom/contact-popup/contact-popup.tsx:1-13` — heavy client component.

**Good Solution - Lazy Load Contact Popup and Cart**

**Implementation**: Use `next/dynamic` with `ssr: false` to load `ContactPopup` and cart UI only when needed.

**Components**:

1. Replace direct imports in `src/app/(site)/layout.tsx` with `dynamic()`.

**Code Example**:

```tsx
// src/app/(site)/layout.tsx
import dynamic from "next/dynamic";

const ContactPopup = dynamic(
  () => import("@/components/custom/contact-popup/contact-popup"),
  { ssr: false },
);
```

**Expected Results**: Initial page payload is smaller. Client components are fetched on demand.

**Pros**: Simple; immediate bundle reduction.
**Cons**: Does not reduce total JS downloaded; just defers it.

---

**Better Solution - Conditional Mount Based on Route or Intent**

**Implementation**: Only mount `ContactPopup` on routes where it is likely to be used (all public pages still, but skip on `/studio`). Mount cart only when `localStorage` indicates a non-empty cart.

**Components**:

1. `src/hooks/use-has-cart-items.ts` — reads `localStorage` on mount.
2. `src/app/(site)/layout.tsx` conditionally renders cart provider.

**Code Example**:

```typescript
// src/hooks/use-has-cart-items.ts
import { useState, useEffect } from "react";

export function useHasCartItems(): boolean {
  const [hasItems, setHasItems] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("cart");
      const cart = raw ? JSON.parse(raw) : [];
      setHasItems(Array.isArray(cart) && cart.length > 0);
    } catch {
      setHasItems(false);
    }
  }, []);

  return hasItems;
}
```

**Expected Results**: First visit with no cart sees no cart JS. Studio route is lighter.

**Pros**: Reduces unnecessary JS for cold visitors.
**Cons**: More complex render logic.

---

**Best Solution - Progressive Hydration with Island Architecture**

**Implementation**: Use server components for the shell. Only hydrate interactive islands (cart button, contact trigger) using lightweight vanilla JS or fine-grained React frameworks (Preact signals, Million.js).

**Components**:

1. Convert `src/app/(site)/layout.tsx` to a server component.
2. Replace heavy client providers with lightweight vanilla JS event handlers for core interactions.
3. Reserve React client components for genuinely complex UI (booking flow).

**Code Example**:

```tsx
// src/app/(site)/layout.tsx (Server Component)
export default function SiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <header>
          <CartButtonIsland />
          <ContactTriggerIsland />
        </header>
        <main>{children}</main>
        <footer>…</footer>
      </body>
    </html>
  );
}

// Islands are thin wrappers that lazy-hydrate only on interaction
// src/components/islands/cart-button-island.tsx
("use client");
import { useState } from "react";

export function CartButtonIsland() {
  const [open, setOpen] = useState(false);
  return <button onClick={() => setOpen(true)}>Cart</button>;
}
```

**Expected Results**: Near-zero client JS for static pages. Booking flow still uses React where needed.

**Pros**: Optimal performance; aligns with Next.js App Router philosophy.
**Cons**: Requires significant refactoring; may conflict with current component patterns.

---

### Issue 2.4: Static block registry limits code splitting

**Evidence**:

- `src/components/custom/layouts/block-renderer.tsx:1-14` — imports all block components eagerly at the top of the file.
- `:30-41` — `COMPONENT_REGISTRY` maps block types to eagerly imported components.

**Good Solution - Dynamic Imports per Block Type**

**Implementation**: Replace eager imports with `next/dynamic` or `React.lazy` per block type in the registry.

**Components**:

1. Update `block-renderer.tsx` to use `dynamic(() => import(...))` for each block.

**Code Example**:

```tsx
// src/components/custom/layouts/block-renderer.tsx
import dynamic from "next/dynamic";

const HeroSection = dynamic(() => import("./hero-section"));
const FeatureSection = dynamic(() => import("./feature-section"));
const TextSection = dynamic(() => import("./text-section"));

export const COMPONENT_REGISTRY: Record<string, React.ComponentType<any>> = {
  heroSection: HeroSection,
  featureSection: FeatureSection,
  textSection: TextSection,
};
```

**Expected Results**: Only blocks present on a given page are loaded.

**Pros**: Simple; aligns with Next.js patterns.
**Cons**: May cause layout shift if blocks are large.

---

**Better Solution - Preload Critical Blocks, Lazy Load Below-Fold**

**Implementation**: Use `dynamic` with `ssr: true` for above-fold blocks (hero) and `ssr: false` or standard dynamic for below-fold blocks.

**Components**:

1. Split registry into `CRITICAL_BLOCKS` and `LAZY_BLOCKS`.
2. Use `<Suspense>` with fallback skeletons for lazy blocks.

**Code Example**:

```tsx
// src/components/custom/layouts/block-renderer.tsx
import dynamic from "next/dynamic";
import { Suspense } from "react";

const HeroSection = dynamic(() => import("./hero-section"), { ssr: true });
const FeatureSection = dynamic(() => import("./feature-section"));

const LAZY_BLOCKS: Record<string, React.ComponentType<any>> = {
  featureSection: FeatureSection,
};

function LazyBlock({ type, ...props }: { type: string }) {
  const Component = LAZY_BLOCKS[type];
  if (!Component) return null;
  return (
    <Suspense fallback={<div className="h-48 animate-pulse bg-gray-100" />}>
      <Component {...props} />
    </Suspense>
  );
}
```

**Expected Results**: Above-fold content is fast; below-fold content does not block LCP.

**Pros**: Balances performance and UX.
**Cons**: Requires manual classification of blocks.

---

**Best Solution - Route-Aware Block Bundles with Preloading Hints**

**Implementation**: Generate a mapping of routes to likely block types at build time. Use `<link rel="preload">` hints for the next likely block chunk.

**Components**:

1. Build-time script that analyzes page queries to predict block usage.
2. Inject preload links in page `<head>` based on predicted blocks.
3. Keep dynamic imports with granular chunks.

**Code Example**:

```typescript
// scripts/generate-block-manifest.ts
import { writeFileSync } from "fs";

const routeBlocks: Record<string, string[]> = {
  "/": ["heroSection", "featureSection"],
  "/services": ["serviceListSection"],
};

writeFileSync(
  "public/block-manifest.json",
  JSON.stringify(routeBlocks, null, 2)
);

// In page head loader
import manifest from "@/public/block-manifest.json";

export function BlockPreload({ route }: { route: string }) {
  const blocks = manifest[route] ?? [];
  return (
    <>
      {blocks.map((block) => (
        <link
          key={block}
          rel="preload"
          as="script"
          href={`/_next/static/chunks/${block}.js`}
        />
      ))}
    </>
  );
}
```

**Expected Results**: Blocks are preloaded before they are needed. No layout shift.

**Pros**: Optimal loading strategy.
**Cons**: Complex build-time tooling.

---

## 3. Performance Analysis - Score: 4/10 ⚡

### Issue 3.1: Postgres pool lacks explicit serverless connection budget/timeouts

**Evidence**:

- `src/lib/private-db/client.ts:18-24` — initializes Drizzle client with a `Pool`.
- `src/lib/private-db/pool-config.ts:3-13` — only sets `connectionString` and `ssl`; no `max`, `idleTimeoutMillis`, `connectionTimeoutMillis`, or `allowExitOnIdle`.

**Good Solution - Add Explicit Pool Limits**

**Implementation**: Set `max: 10`, `idleTimeoutMillis: 30000`, and `connectionTimeoutMillis: 5000` in `pool-config.ts`.

**Components**:

1. Modify `src/lib/private-db/pool-config.ts`.

**Code Example**:

```typescript
// src/lib/private-db/pool-config.ts
import { PoolConfig } from "pg";

export const poolConfig: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: true,
};
```

**Expected Results**: Pool does not exhaust database connections under load.

**Pros**: Simple; immediate protection.
**Cons**: Static limit may not be optimal for all traffic patterns.

---

**Better Solution - Environment-Aware Pool Config**

**Implementation**: Derive pool size from `WEB_CONCURRENCY` or Vercel function config, with lower limits for edge functions.

**Components**:

1. `src/lib/private-db/pool-config.ts` reads `WEB_CONCURRENCY`.
2. `max` is set to `Math.min(10, Math.max(2, parseInt(process.env.WEB_CONCURRENCY ?? "2")))`.

**Code Example**:

```typescript
// src/lib/private-db/pool-config.ts
import { PoolConfig } from "pg";

const concurrency = parseInt(process.env.WEB_CONCURRENCY ?? "2", 10);

export const poolConfig: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
  max: Math.min(10, Math.max(2, concurrency)),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: true,
};
```

**Expected Results**: Pool size adapts to deployment environment.

**Pros**: Environment-aware.
**Cons**: Vercel serverless concurrency is not always predictable.

---

**Best Solution - Connection Proxy (PgBouncer / Supabase Pooler)**

**Implementation**: Do not connect directly to Postgres from serverless functions. Use a connection pooler (PgBouncer, Supabase Pooler, or AWS RDS Proxy).

**Components**:

1. Update `DATABASE_URL` to point to the pooler.
2. Set pooler `pool_mode: transaction`.
3. Reduce application pool `max` to `2-3`.

**Code Example**:

```typescript
// src/lib/private-db/pool-config.ts
import { PoolConfig } from "pg";

export const poolConfig: PoolConfig = {
  connectionString: process.env.DATABASE_URL_POOLER,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: true,
};
```

**Expected Results**: Database connections are managed by a dedicated proxy. Serverless scaling does not overwhelm Postgres.

**Pros**: Industry standard for serverless + Postgres.
**Cons**: Additional infrastructure cost and latency.

---

### Issue 3.2: Booking availability fans out to Sanity, DB, and Google Calendar per request; global calendar lock can bottleneck finalization

**Evidence**:

- `src/app/api/booking/availability/route.ts:119-162` — queries Sanity, DB, and Google Calendar in parallel per request.
- `src/lib/booking/operational-store.ts:8` and `:39-53` — uses a global `booking:calendar-lock` in KV.

**Good Solution - Cache Availability Results**

**Implementation**: Cache the merged availability result in KV with a short TTL (e.g., 30 seconds) keyed by date range.

**Components**:

1. `src/lib/booking/availability-cache.ts` — reads from KV first, falls back to full query.

**Code Example**:

```typescript
// src/lib/booking/availability-cache.ts
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

export async function getAvailability(
  startDate: string,
  endDate: string,
  fetcher: () => Promise<unknown>,
): Promise<unknown> {
  const key = `availability:${startDate}:${endDate}`;
  const cached = await redis.get(key);
  if (cached) return cached;

  const result = await fetcher();
  await redis.setex(key, 30, JSON.stringify(result));
  return result;
}
```

**Expected Results**: Repeated availability requests within 30 seconds are served from cache.

**Pros**: Reduces fan-out; fast.
**Cons**: Stale cache may show already-booked slots.

---

**Better Solution - Pessimistic Locking with Timeout**

**Implementation**: Replace the global lock with a per-slot lock and add a timeout so stuck locks auto-release.

**Components**:

1. `booking:lock:slot-{slotId}` with TTL of 60 seconds.
2. Lock acquisition uses `SET NX EX`.

**Code Example**:

```typescript
// src/lib/booking/slot-lock.ts
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

export async function acquireSlotLock(
  slotId: string,
  ttlSeconds: number = 60,
): Promise<boolean> {
  const key = `booking:lock:slot-${slotId}`;
  const result = await redis.set(key, "locked", "NX", "EX", ttlSeconds);
  return result === "OK";
}

export async function releaseSlotLock(slotId: string): Promise<void> {
  await redis.del(`booking:lock:slot-${slotId}`);
}
```

**Expected Results**: Only conflicting slots are locked. A stuck lock expires automatically.

**Pros**: Finer granularity; self-healing.
**Cons**: More KV keys to manage.

---

**Best Solution - Saga Pattern with Compensation**

**Implementation**: Treat booking finalization as a distributed saga. Reserve the slot in DB first, then sync to calendar. If calendar sync fails, release the DB reservation (compensating transaction).

**Components**:

1. `booking_reservations` table with `status: held | confirmed | released`.
2. Background worker syncs confirmed reservations to calendar.
3. No global lock; DB row-level locking handles conflicts.

**Code Example**:

```typescript
// src/lib/booking/reservation-saga.ts
import { db } from "@/lib/private-db/client";
import { reservations } from "@/lib/private-db/schema";
import { eq } from "drizzle-orm";

export async function holdSlot(slotId: string, customerId: string) {
  const [reservation] = await db
    .insert(reservations)
    .values({
      slotId,
      customerId,
      status: "held",
      heldAt: new Date(),
    })
    .returning();

  try {
    await syncToCalendar(reservation);
    await db
      .update(reservations)
      .set({ status: "confirmed" })
      .where(eq(reservations.id, reservation.id));
  } catch (err) {
    await db
      .update(reservations)
      .set({ status: "released" })
      .where(eq(reservations.id, reservation.id));
    throw err;
  }
}
```

**Expected Results**: No KV lock bottleneck. Calendar sync failures are handled gracefully.

**Pros**: Scalable; resilient.
**Cons**: Complex; requires background worker.

---

### Issue 3.3: Image/bundle optimization gaps

**Evidence**:

- `src/components/ui/sanity-image.tsx:31-42` — does not request exact Sanity widths or LQIP.
- `src/components/custom/layouts/hero-carousel.tsx:58-65` — uses 3840x2160 hero images.
- `npm run build` output: static assets total ~8,917,638 bytes; largest chunk is 4,196,167 bytes.

**Good Solution - Add Sanity Widths and srcSet**

**Implementation**: Update `SanityImage` to request specific widths and provide `srcSet`.

**Components**:

1. `src/components/ui/sanity-image.tsx` — add `w=...` param and `srcSet`.

**Code Example**:

```tsx
// src/components/ui/sanity-image.tsx
import { urlFor } from "@/sanity/lib/image";

export function SanityImage({
  image,
  alt,
  ...props
}: {
  image: { _ref: string };
  alt?: string;
} & React.ImgHTMLAttributes<HTMLImageElement>) {
  const srcSet = [320, 640, 960, 1280, 1920, 2560]
    .map((w) => `${urlFor(image).width(w).auto("format").url()} ${w}w`)
    .join(", ");

  return (
    <img
      src={urlFor(image).width(1280).auto("format").url()}
      srcSet={srcSet}
      sizes="(max-width: 768px) 100vw, 50vw"
      alt={alt ?? ""}
      {...props}
    />
  );
}
```

**Expected Results**: Browsers download appropriately sized images.

**Pros**: Immediate bandwidth savings.
**Cons**: More URL generation at render time.

---

**Better Solution - Next.js Image Component with Sanity Loader**

**Implementation**: Replace raw `<img>` with `next/image` and a custom Sanity loader.

**Components**:

1. `src/components/ui/sanity-image.tsx` wraps `next/image`.
2. Custom loader generates `w={width}&q={quality}`.

**Code Example**:

```tsx
// src/components/ui/sanity-image.tsx
import Image from "next/image";
import { urlFor } from "@/sanity/lib/image";

const sanityLoader = ({ src, width }: { src: string; width: number }) => {
  return urlFor({ _ref: src }).width(width).auto("format").url();
};

export function SanityImage({
  image,
  alt,
  ...props
}: {
  image: { _ref: string };
  alt?: string;
} & Omit<React.ComponentProps<typeof Image>, "src" | "alt" | "loader">) {
  return (
    <Image
      loader={sanityLoader}
      src={image._ref}
      alt={alt ?? ""}
      width={1280}
      height={720}
      {...props}
    />
  );
}
```

**Expected Results**: Automatic optimization, lazy loading, and blur placeholder support.

**Pros**: Best practice for Next.js.
**Cons**: May conflict with current styling approach.

---

**Best Solution - Responsive Image Service with CDN and LQIP**

**Implementation**: Use Sanity's `?blur=10&w=100` for LQIP placeholders, integrate with a global CDN (Cloudflare Images or Imgix), and generate responsive variants at build time.

**Components**:

1. Build-time script generates responsive image variants.
2. CDN serves optimized formats (WebP, AVIF).
3. LQIP embedded as base64 in page HTML.

**Code Example**:

```typescript
// scripts/generate-image-variants.ts
import { glob } from "glob";
import { urlFor } from "@/sanity/lib/image";
import { writeFileSync } from "fs";

async function generateVariants() {
  const images = await glob("public/images/**/*.{jpg,png}");
  const manifest: Record<string, string[]> = {};

  for (const img of images) {
    const widths = [320, 640, 960, 1280, 1920];
    manifest[img] = widths.map((w) =>
      urlFor({ _ref: img }).width(w).format("webp").url(),
    );
  }

  writeFileSync(
    "public/image-variants.json",
    JSON.stringify(manifest, null, 2),
  );
}

generateVariants();
```

**Expected Results**: Fastest possible image loading.

**Pros**: Optimal performance.
**Cons**: Infrastructure cost.

---

### Issue 3.4: Layout-triggering animations and scroll state

**Evidence**:

- `src/components/custom/training-detail-items.tsx:107-120` — animates `grid-template-rows` and `width` (layout properties, high cost).
- `src/components/custom/layouts/hero-carousel.tsx:117-118` — animates `width`.
- `src/components/custom/layouts/header-wrapper.tsx:20-32` — updates scroll state on every scroll event without throttling or `requestAnimationFrame`.

**Good Solution - Use transform Instead of width/grid-rows**

**Implementation**: Replace `width` and `grid-template-rows` animations with `transform: scaleX()` and `max-height` transitions.

**Components**:

1. Refactor `training-detail-items.tsx` and `hero-carousel.tsx` to use `transform` and `opacity`.

**Code Example**:

```css
/* Instead of animating width */
.animated-bar {
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 0.3s ease;
}

.animated-bar.active {
  transform: scaleX(1);
}

/* Instead of animating grid-template-rows */
.expandable-section {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease;
}

.expandable-section.open {
  max-height: 500px;
}
```

**Expected Results**: Animations run on the compositor thread.

**Pros**: Immediate performance gain.
**Cons**: May require visual redesign.

---

**Better Solution - Use will-change and Reduced Motion**

**Implementation**: Add `will-change: transform` before animations and respect `prefers-reduced-motion`.

**Components**:

1. CSS/JS checks for `prefers-reduced-motion: reduce`.
2. `will-change` applied conditionally.

**Code Example**:

```tsx
// src/hooks/use-reduced-motion.ts
import { useState, useEffect } from "react";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mql.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return reduced;
}

// In component
const reducedMotion = useReducedMotion();
<div style={{ willChange: reducedMotion ? "auto" : "transform" }} />;
```

**Expected Results**: Respects user preferences; hints browser for optimization.

**Pros**: Accessible; performant.
**Cons**: `will-change` can be misused.

---

**Best Solution - Hardware-Accelerated Motion Library with Batch Reads**

**Implementation**: Use Motion's layout animations with `layout` prop and batch scroll reads with `requestAnimationFrame`.

**Components**:

1. Refactor scroll handler in `header-wrapper.tsx` to use `requestAnimationFrame`.
2. Use Motion's `layout` prop for size changes.

**Code Example**:

```tsx
// src/components/custom/layouts/header-wrapper.tsx
import { useRef, useEffect, useState } from "react";

export function HeaderWrapper() {
  const [scrolled, setScrolled] = useState(false);
  const rafId = useRef<number | null>(null);

  useEffect(() => {
    const onScroll = () => {
      if (rafId.current !== null) return;
      rafId.current = requestAnimationFrame(() => {
        setScrolled(window.scrollY > 50);
        rafId.current = null;
      });
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    };
  }, []);

  return (
    <header className={scrolled ? "bg-white shadow" : "bg-transparent"}>
      …
    </header>
  );
}
```

**Expected Results**: Smooth 60fps animations; no layout thrashing.

**Pros**: Optimal UX.
**Cons**: Requires careful implementation.

---

## 4. Accessibility Analysis - Score: 3/10 ♿

### Issue 4.1: SanityImage defaults alt to empty string and schema image alt is often optional

**Evidence**:

- `src/components/ui/sanity-image.tsx:36` — `alt={alt ?? ""}`.
- `src/sanity/schemas/documents/product.ts:203` — image alt optional.
- `src/sanity/schemas/documents/service.ts:100/120/131` — alt optional.
- `src/sanity/schemas/objects/layout/hero-section.ts:31/83` — alt optional.

**Good Solution - Require Alt in Schemas**

**Implementation**: Add `validation: (Rule) => Rule.required()` to all image `alt` fields in Sanity schemas.

**Components**:

1. Update schema files to require alt.

**Code Example**:

```typescript
// src/sanity/schemas/documents/product.ts
{
  name: "alt",
  type: "string",
  title: "Alt Text",
  validation: (Rule) => Rule.required().error("Alt text is required for accessibility"),
}
```

**Expected Results**: Editors cannot publish images without alt text.

**Pros**: Enforced at source.
**Cons**: Retroactive content may break validation.

---

**Better Solution - Fallback Alt from Context + Schema Required**

**Implementation**: Require alt in schema, but also provide intelligent fallbacks (product name, section title) in the component.

**Components**:

1. Schema requires alt.
2. Component uses `alt || fallback || ""`.

**Code Example**:

```tsx
// src/components/ui/sanity-image.tsx
export function SanityImage({
  image,
  alt,
  fallbackAlt,
  ...props
}: {
  image: { _ref: string; alt?: string };
  alt?: string;
  fallbackAlt?: string;
} & React.ImgHTMLAttributes<HTMLImageElement>) {
  const effectiveAlt = alt ?? image.alt ?? fallbackAlt ?? "";

  return <img src={urlFor(image).url()} alt={effectiveAlt} {...props} />;
}
```

**Expected Results**: Never empty alt for meaningful images.

**Pros**: Redundant safety.
**Cons**: More component logic.

---

**Best Solution - Automated Alt Generation + Editorial Override**

**Implementation**: Use AI vision API to generate alt text on image upload, with editor override.

**Components**:

1. Sanity plugin or webhook on asset upload.
2. AI-generated alt stored as default.
3. Editor can refine.

**Code Example**:

```typescript
// sanity.config.ts plugin stub
import { definePlugin } from "sanity";

export const autoAltPlugin = definePlugin({
  name: "auto-alt",
  document: {
    actions: (prev, context) => {
      if (context.schemaType !== "sanity.imageAsset") return prev;
      // Hook into asset upload to call vision API
      return prev;
    },
  },
});
```

**Expected Results**: All images have alt text by default.

**Pros**: Scalable.
**Cons**: Cost; privacy concerns.

---

### Issue 4.2: Auto-rotating carousel and contact popup ignore reduced motion/unexpected interruption

**Evidence**:

- `src/components/custom/layouts/hero-carousel.tsx:35-40` — auto-rotates without `prefers-reduced-motion` check.
- `src/components/custom/contact-popup/contact-popup.tsx:39-48` — popup appears without reduced-motion awareness.

**Good Solution - Respect prefers-reduced-motion**

**Implementation**: Check `window.matchMedia('(prefers-reduced-motion: reduce)')` before auto-rotating or animating popup.

**Components**:

1. `src/hooks/use-reduced-motion.ts`.
2. Apply in carousel and popup.

**Code Example**:

```tsx
// src/components/custom/layouts/hero-carousel.tsx
import { useReducedMotion } from "@/hooks/use-reduced-motion";

export function HeroCarousel() {
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion) return;
    const interval = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % slides.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [reducedMotion, slides.length]);

  return <div>…</div>;
}
```

**Expected Results**: Users with motion sensitivity see static content.

**Pros**: Simple; WCAG compliant.
**Cons**: Static carousel is less engaging.

---

**Better Solution - Pause on Hover/Focus and Provide Controls**

**Implementation**: Carousel pauses on hover/focus and provides manual prev/next controls. Popup entrance is instant when reduced motion is preferred.

**Components**:

1. `onMouseEnter` / `onFocus` pause timers.
2. Visible pause/play button.

**Code Example**:

```tsx
// src/components/custom/layouts/hero-carousel.tsx
export function HeroCarousel() {
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    if (isPaused) return;
    const interval = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % slides.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [isPaused, slides.length]);

  return (
    <div
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={() => setIsPaused(false)}
    >
      …
      <button onClick={() => setIsPaused((p) => !p)}>
        {isPaused ? "Play" : "Pause"}
      </button>
    </div>
  );
}
```

**Expected Results**: User-controlled experience.

**Pros**: Better UX for all users.
**Cons**: More UI elements.

---

**Best Solution - Editorial Carousel Replaced with Static Hero**

**Implementation**: Replace auto-rotating carousel with a single, editorially chosen hero image or a user-initiated gallery.

**Components**:

1. Remove auto-rotation entirely.
2. Use a prominent static hero.

**Code Example**:

```tsx
// src/components/custom/layouts/static-hero.tsx
export function StaticHero({
  image,
  title,
  cta,
}: {
  image: { _ref: string };
  title: string;
  cta: { label: string; href: string };
}) {
  return (
    <section className="relative h-[60vh] w-full">
      <img
        src={urlFor(image).width(1920).auto("format").url()}
        alt={title}
        className="absolute inset-0 h-full w-full object-cover"
      />
      <div className="relative z-10 flex flex-col items-center justify-center h-full text-white">
        <h1>{title}</h1>
        <a href={cta.href}>{cta.label}</a>
      </div>
    </section>
  );
}
```

**Expected Results**: Zero motion issues; better performance; clearer CTA.

**Pros**: Solves a11y, performance, and CTA clarity simultaneously.
**Cons**: Requires design change.

---

### Issue 4.3: Booking loading state lacks live region

**Evidence**:

- `src/components/booking/booking-flow.tsx:362-363` — loading state rendered without `aria-live`.

**Good Solution - Add aria-live="polite"**

**Implementation**: Wrap loading indicator in a div with `aria-live="polite"`.

**Components**:

1. One-line addition in `booking-flow.tsx`.

**Code Example**:

```tsx
// In src/components/booking/booking-flow.tsx
<div aria-live="polite" aria-atomic="true">
  {isLoading && <span>Loading available slots…</span>}
</div>
```

**Expected Results**: Screen readers announce loading.

**Pros**: Trivial to implement.
**Cons**: May be chatty if loading is frequent.

---

**Better Solution - Use role="status" with Visually Hidden Text**

**Implementation**: Use `role="status"` and a visually hidden span that updates.

**Components**:

1. `src/components/ui/visually-hidden.tsx`.
2. Update booking flow.

**Code Example**:

```tsx
// src/components/ui/visually-hidden.tsx
export function VisuallyHidden({ children }: { children: React.ReactNode }) {
  return (
    <span className="absolute h-px w-px overflow-hidden whitespace-nowrap border-0 p-0 [clip:rect(0,0,0,0)]">
      {children}
    </span>
  );
}

// In booking-flow.tsx
<div role="status">
  {isLoading && (
    <VisuallyHidden>Loading available slots, please wait.</VisuallyHidden>
  )}
  <Spinner visible={isLoading} />
</div>;
```

**Expected Results**: Clean, semantic live region.

**Pros**: Best practice.
**Cons**: Slightly more code.

---

**Best Solution - Full Accessibility Wrapper for Async States**

**Implementation**: Create a reusable `AsyncState` component that manages `aria-live`, `aria-busy`, focus management, and error announcements.

**Components**:

1. `src/components/ui/async-state.tsx`.
2. Use across booking, checkout, and form flows.

**Code Example**:

```tsx
// src/components/ui/async-state.tsx
import { useEffect, useRef } from "react";

export function AsyncState({
  status,
  loadingText,
  errorText,
  children,
}: {
  status: "idle" | "loading" | "error" | "success";
  loadingText: string;
  errorText?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status === "error" && ref.current) {
      ref.current.focus();
    }
  }, [status]);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      aria-live="polite"
      aria-busy={status === "loading"}
      role="status"
    >
      {status === "loading" && <span>{loadingText}</span>}
      {status === "error" && <span>{errorText ?? "An error occurred."}</span>}
      {status === "success" && children}
    </div>
  );
}
```

**Expected Results**: Consistent, accessible async UX everywhere.

**Pros**: Scalable; consistent.
**Cons**: Requires refactoring multiple components.

---

### Issue 4.4: Basic accessibility test has false negatives and no axe-core integration

**Evidence**:

- `tests/utils/test-helpers.ts:54-62` — only checks `img:not([alt])`.
- `package.json:24-75` — no `@axe-core/playwright` in devDependencies.
- `tests/navigation.spec.ts` — comment suggests axe-core was considered.

**Good Solution - Add axe-core/playwright and Run in One Spec**

**Implementation**: Install `@axe-core/playwright`, add a single spec that runs axe on key pages.

**Components**:

1. `npm install -D @axe-core/playwright`.
2. `tests/a11y.spec.ts`.

**Code Example**:

```shell
npm install -D @axe-core/playwright
```

```typescript
// tests/a11y.spec.ts
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const pages = ["/", "/services", "/training-programs", "/contact"];

for (const path of pages) {
  test(`axe scan on ${path}`, async ({ page }) => {
    await page.goto(path);
    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    expect(accessibilityScanResults.violations).toEqual([]);
  });
}
```

**Expected Results**: Automated a11y scans on key pages.

**Pros**: Immediate coverage.
**Cons**: May find many issues at once.

---

**Better Solution - Integrate axe into E2E CI Gate**

**Implementation**: Run axe on every page transition in E2E tests. Fail the test on violations.

**Components**:

1. Custom Playwright fixture with `axe`.
2. Assert `violations.length === 0`.

**Code Example**:

```typescript
// tests/fixtures/axe-fixture.ts
import { test as base } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

export const test = base.extend({
  axe: async ({ page }, use) => {
    const builder = new AxeBuilder({ page });
    await use(builder);
  },
});

// In a spec
import { test, expect } from "./fixtures/axe-fixture";

test("homepage has no a11y violations", async ({ page, axe }) => {
  await page.goto("/");
  const results = await axe.analyze();
  expect(results.violations).toEqual([]);
});
```

**Expected Results**: No a11y regressions.

**Pros**: Comprehensive.
**Cons**: Slower E2E runs.

---

**Best Solution - Multi-Layer a11y: axe CI + Manual Audit + User Testing**

**Implementation**: Combine automated axe scans, recurring manual WCAG 2.1 audits, and paid user testing with disabled users.

**Components**:

1. axe in CI.
2. Recurring external audit.
3. User testing panel.

**Code Example**:

```yaml
# .github/workflows/a11y.yml
name: Accessibility
on:
  schedule:
    - cron: "0 9 * * 1"
jobs:
  axe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npx playwright install chromium
      - run: npm test -- --grep "axe"
```

**Expected Results**: Genuine accessibility, not just compliance.

**Pros**: Real-world validation.
**Cons**: Ongoing cost.

---

## 5. DevOps Analysis - Score: 2/10 ✅

### Issue 5.1: No repo-visible CI/CD workflow or enforced quality gates

**Evidence**:

- Directory search: no `.github/**` files found.
- `vercel.json:1-8` — only a cron job; no CI configuration.
- `package.json:5-22` — scripts exist but are not wired to CI.

**Good Solution - Add a Basic GitHub Actions Workflow**

**Implementation**: Create `.github/workflows/ci.yml` that runs lint, unit tests, and build.

**Components**:

1. `.github/workflows/ci.yml`.

**Code Example**:

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run test:unit
      - run: npm run build
```

**Expected Results**: Every PR is verified.

**Pros**: Simple; standard.
**Cons**: Does not include E2E or security scans.

---

**Better Solution - Staged CI with E2E and Audit**

**Implementation**: Add jobs for Playwright E2E and `npm audit`.

**Components**:

1. CI workflow with `lint`, `unit`, `audit`, `e2e`, `build` jobs.
2. E2E job starts dev server and runs Playwright.

**Code Example**:

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  lint-and-unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run test:unit
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm audit --audit-level=moderate
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm test
```

**Expected Results**: Comprehensive quality gate.

**Pros**: Catches more issues.
**Cons**: Slower CI; requires Playwright install.

---

**Best Solution - GitOps with Preview Environments and Required Checks**

**Implementation**: Use Vercel preview deployments + GitHub required status checks. E2E runs against preview URL.

**Components**:

1. Required checks in branch protection.
2. E2E job accepts `preview_url` input.
3. Separate staging and production deploy workflows.

**Code Example**:

```yaml
# .github/workflows/deploy-staging.yml
name: Deploy Staging
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          github-comment: true
```

**Expected Results**: Production deploys are gated by full test suite.

**Pros**: Industry standard.
**Cons**: Complex setup.

---

### Issue 5.2: Monitoring/logging is console-heavy without structured observability/alerting

**Evidence**:

- `console.warn/error` in API routes: `src/app/api/webhooks/card-transactions/route.ts:107-138`, square route, revalidate route.
- `package.json:24-75` — no `@sentry/nextjs`, `@opentelemetry/api`, or structured logging dependencies.

**Good Solution - Structured JSON Logging**

**Implementation**: Replace `console.*` with a lightweight logger that outputs JSON.

**Components**:

1. `src/lib/logging/logger.ts`.

**Code Example**:

```typescript
// src/lib/logging/logger.ts
export function log(
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
) {
  console.log(
    JSON.stringify({
      level,
      message,
      timestamp: new Date().toISOString(),
      service: "lash-her-frontend",
      ...meta,
    }),
  );
}
```

**Expected Results**: Logs are parseable.

**Pros**: Simple.
**Cons**: No aggregation or alerting.

---

**Better Solution - Integrate Sentry**

**Implementation**: Add `@sentry/nextjs` for error tracking and performance monitoring.

**Components**:

1. `npm install @sentry/nextjs`.
2. `sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`.

**Code Example**:

```typescript
// sentry.client.config.ts
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
});
```

**Expected Results**: Errors are captured with stack traces and context.

**Pros**: Rich error context; performance tracing.
**Cons**: Cost at scale.

---

**Best Solution - OpenTelemetry + Alerting**

**Implementation**: Instrument with OTel, export to a backend (Honeycomb, Datadog, or self-hosted), and set up PagerDuty/Opsgenie alerts for error rate spikes.

**Components**:

1. `@opentelemetry/api` + auto-instrumentations.
2. Alert rules for 5xx rate > 1% and webhook failure rate > 5%.

**Code Example**:

```typescript
// src/lib/telemetry/instrumentation.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
```

**Expected Results**: Full observability and proactive alerting.

**Pros**: Vendor-agnostic; comprehensive.
**Cons**: Significant setup.

---

### Issue 5.3: Backup/DR runbooks exist but production proof is manual

**Evidence**:

- `docs/production-cutover-checklist.md` — has backup/PITR placeholders; no automated validation scripts referenced.

**Good Solution - Documented Recurring Manual Drill**

**Implementation**: Schedule and document a recurring manual restore test.

**Components**:

1. Calendar reminder.
2. Runbook update.

**Code Example**:

```shell
# docs/runbooks/dr-drill.sh
#!/bin/bash
set -euo pipefail

echo "Starting DR drill: $(date)"

# 1. List available backups
pg_dump --list-backups || true

# 2. Restore to staging DB
pg_restore --clean --dbname="$STAGING_DATABASE_URL" "$LATEST_BACKUP_PATH"

# 3. Run health check
psql "$STAGING_DATABASE_URL" -c "SELECT COUNT(*) FROM orders;"

echo "DR drill complete: $(date)"
```

**Expected Results**: Team knows the procedure.

**Pros**: Low effort.
**Cons**: Manual; may be skipped.

---

**Better Solution - Automated Backup Validation**

**Implementation**: Cron job that restores the latest backup to a staging database and runs a health check.

**Components**:

1. Recurring cron in `vercel.json` or GitHub Actions.
2. Health check query.

**Code Example**:

```yaml
# .github/workflows/backup-validation.yml
name: Backup Validation
on:
  schedule:
    - cron: "0 6 * * 1"
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          pg_restore --clean --dbname="$STAGING_DATABASE_URL" "$LATEST_BACKUP_PATH"
      - run: |
          psql "$STAGING_DATABASE_URL" -c "SELECT COUNT(*) FROM orders;"
```

**Expected Results**: Backups are proven restorable.

**Pros**: Automated proof.
**Cons**: Requires staging DB.

---

**Best Solution - Continuous DR Testing with Chaos Engineering**

**Implementation**: Regularly simulate database failures and verify failover to PITR or replica. Use chaos tools (Litmus, Gremlin) or manual scripts.

**Components**:

1. Recurring DR drill.
2. Automated RPO/RTO measurement.

**Code Example**:

```shell
# scripts/chaos-drill.sh
#!/bin/bash
set -euo pipefail

START_TIME=$(date +%s)

# Simulate DB failure by revoking connections
psql "$DATABASE_URL" -c "REVOKE CONNECT ON DATABASE lash_her FROM PUBLIC;"

# Trigger failover or PITR restore
# (Platform-specific commands)

# Measure recovery time
END_TIME=$(date +%s)
RTO=$((END_TIME - START_TIME))
echo "RTO: ${RTO}s"
```

**Expected Results**: Confident recovery capability.

**Pros**: Real-world validation.
**Cons**: Complex; risky if not isolated.

---

### Issue 5.4: Artifact hygiene: ignored tarballs and `.playwright-mcp` logs

**Evidence**:

- Root contains `production-pre-cutover-backup.tar.gz`, `staging-approved-cutover.tar.gz`.
- `.gitignore:58-61` and `:76-77` ignores `.playwright-mcp/` and tarballs going forward.
- Tracked `.playwright-mcp/*` files exist despite the ignore rule.

**Good Solution - Remove Artifacts from Index**

**Implementation**: `git rm --cached` for tarballs and `.playwright-mcp/` files.

**Components**:

1. One-time cleanup command.

**Code Example**:

```shell
git rm --cached production-pre-cutover-backup.tar.gz staging-approved-cutover.tar.gz
git rm -r --cached .playwright-mcp/
git commit -m "Remove build artifacts and logs from index"
```

**Expected Results**: Clean index.

**Pros**: Immediate.
**Cons**: History still contains them.

---

**Better Solution - Add Pre-Commit Hook for Large Files**

**Implementation**: Use `husky` + `lint-staged` to block commits of files > 1MB.

**Components**:

1. `.husky/pre-commit`.

**Code Example**:

```shell
# .husky/pre-commit
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

# Block files larger than 1MB
LARGE_FILES=$(git diff --cached --name-only --diff-filter=ACM | while read file; do
  if [ -f "$file" ] && [ "$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null)" -gt 1048576 ]; then
    echo "$file"
  fi
done)

if [ -n "$LARGE_FILES" ]; then
  echo "Error: Files larger than 1MB detected:"
  echo "$LARGE_FILES"
  exit 1
fi
```

**Expected Results**: No future large file commits.

**Pros**: Automated prevention.
**Cons**: Adds dependency.

---

**Best Solution - Repository Hygiene Audit with BFG Repo-Cleaner**

**Implementation**: Use BFG Repo-Cleaner to purge large files and secrets from git history. Enforce pre-commit hooks and secret scanning.

**Components**:

1. BFG run on all branches.
2. Force-push to origin.
3. Team notification to re-clone.

**Code Example**:

```shell
# Download BFG
wget https://repo1.maven.org/maven2/com/madgag/bfg/1.14.0/bfg-1.14.0.jar

# Run BFG to remove files > 1MB
java -jar bfg-1.14.0.jar --strip-blobs-bigger-than 1M .
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

**Expected Results**: Clean history going forward.

**Pros**: Definitive cleanup.
**Cons**: Disruptive; requires coordination.

---

## 6. Testing Analysis - Score: 4/10 🧪

### Issue 6.1: Coverage not instrumented

**Evidence**:

- `package.json:14` — `"test:unit": "tsx --test \"src/**/*.test.ts\""`.
- `package.json:5-22` — no `c8`, `nyc`, or coverage-related scripts.

**Good Solution - Add c8 to Test Script**

**Implementation**: `npm install -D c8` and update test script.

**Components**:

1. `package.json` script: `"test:unit:coverage": "c8 tsx --test 'src/**/*.test.ts'"`.

**Code Example**:
// package.json

```json
{
  "scripts": {
    "test:unit": "tsx --test 'src/**/*.test.ts'",
    "test:unit:coverage": "c8 tsx --test 'src/**/*.test.ts'"
  }
}
```

**Expected Results**: Coverage reports generated.

**Pros**: Simple.
**Cons**: c8 is slower.

---

**Better Solution - Coverage Gate in CI**

**Implementation**: Generate coverage in CI and fail if it drops below a threshold.

**Components**:

1. CI job runs coverage.
2. `.nycrc.json` or `c8` config with thresholds.

**Code Example**:
// .c8rc.json

```json
{
  "check-coverage": true,
  "lines": 70,
  "functions": 60,
  "branches": 50,
  "statements": 70
}
```

**Expected Results**: No coverage regressions.

**Pros**: Enforced discipline.
**Cons**: May block legitimate refactors.

---

**Best Solution - Coverage-Driven Development**

**Implementation**: Require coverage for all new code. Use Istanbul + Codecov for PR comments showing coverage delta.

**Components**:

1. Codecov integration.
2. PR checks for coverage.

**Code Example**:

```yaml
# .github/workflows/coverage.yml
name: Coverage
on: [pull_request]
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

**Expected Results**: High and stable coverage.

**Pros**: Transparent.
**Cons**: Tooling overhead.

---

### Issue 6.2: Skipped/weak tests

**Evidence**:

- `tests/gallery.spec.ts:63` — skipped lightbox test.
- Conditional tests with no assertions at lines 53-60 and 103-113.

**Good Solution - Re-enable or Delete Skipped Tests**

**Implementation**: Fix or remove the skipped lightbox test. Add assertions to conditional blocks.

**Components**:

1. `tests/gallery.spec.ts`.

**Code Example**:

```typescript
// tests/gallery.spec.ts
import { test, expect } from "@playwright/test";

test("lightbox opens on image click", async ({ page }) => {
  await page.goto("/gallery");
  await page.locator("[data-testid='gallery-image']").first().click();
  await expect(page.locator("[data-testid='lightbox']")).toBeVisible();
});
```

**Expected Results**: No skipped tests.

**Pros**: Immediate.
**Cons**: May require fixing underlying bugs.

---

**Better Solution - Test Quality Linting**

**Implementation**: Add `eslint-plugin-jest-playwright` or similar to enforce assertions in tests.

**Components**:

1. ESLint plugin.
2. Rule: `expect-expect`.

**Code Example**:
// .eslintrc.json

```json
{
  "plugins": ["jest-playwright"],
  "rules": {
    "jest-playwright/expect-expect": "error"
  }
}
```

**Expected Results**: No assertion-less tests.

**Pros**: Automated enforcement.
**Cons**: May have false positives.

---

**Best Solution - Mutation Testing**

**Implementation**: Use Stryker to verify that tests actually catch bugs.

**Components**:

1. `npm install -D @stryker-mutator/core`.
2. Run in CI.

**Code Example**:
// stryker.config.json

```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "npm",
  "reporters": ["html", "clear-text", "progress"],
  "testRunner": "command",
  "commandRunner": {
    "command": "npm run test:unit"
  },
  "coverageAnalysis": "perTest"
}
```

**Expected Results**: Tests are proven effective.

**Pros**: Validates test quality.
**Cons**: Very slow.

---

### Issue 6.3: E2E/security/performance not required by visible CI

**Evidence**:

- Directory search: no `.github/**` files found.
- `playwright.config.ts` exists but `.github/workflows/**` does not.

**Good Solution - Add Playwright to CI**

**Implementation**: Add Playwright job to GitHub Actions.

**Components**:

1. `.github/workflows/ci.yml` job.

**Code Example**:

```yaml
# .github/workflows/ci.yml
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm test
```

**Expected Results**: E2E runs on PR.

**Pros**: Standard.
**Cons**: Flaky tests may slow development.

---

**Better Solution - Separate Off-Peak E2E + Security Scans**

**Implementation**: E2E runs on PR, but full security scan (OWASP ZAP) and Lighthouse CI run on a recurring schedule.

**Components**:

1. Recurring workflow.
2. Slack/email alerts on failure.

**Code Example**:

```yaml
# .github/workflows/recurring-scans.yml
name: Recurring Scans
on:
  schedule:
    - cron: "0 2 * * *"
jobs:
  zap:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker run -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t https://lashher.com
  lighthouse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: treosh/lighthouse-ci-action@v12
        with:
          urls: |
            https://lashher.com/
            https://lashher.com/services
```

**Expected Results**: Deep scans without PR friction.

**Pros**: Balanced.
**Cons**: Recurring failures may be ignored.

---

**Best Solution - Continuous Quality Dashboard**

**Implementation**: Use SonarQube or Code Climate for continuous quality, security, and coverage tracking.

**Components**:

1. SonarQube project.
2. PR decoration.

**Code Example**:

```yaml
# .github/workflows/sonar.yml
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
          SONAR_HOST_URL: ${{ secrets.SONAR_HOST_URL }}
```

**Expected Results**: Single source of truth for quality.

**Pros**: Comprehensive.
**Cons**: Infrastructure cost.

---

### Issue 6.4: Lint warnings remain

**Evidence**:

- `npm run lint` — 7 warnings: `cta-section-image.tsx:14`, `cart-storage.ts:25`, `gallery.spec.ts:56/104`.

**Good Solution - Fix Remaining Warnings**

**Implementation**: Remove unused variables and imports.

**Components**:

1. Direct code edits.

**Code Example**:

```typescript
// Before: src/components/custom/cta-section-image.tsx line 14
// import { SomeUnusedThing } from "@/lib/somewhere";

// After: remove the unused import entirely
```

**Expected Results**: Zero warnings.

**Pros**: Immediate.
**Cons**: Tedious.

---

**Better Solution - Zero-Warnings Policy with CI Gate**

**Implementation**: CI fails on any lint warning.

**Components**:

1. `npm run lint -- --max-warnings=0` in CI.

**Code Example**:

```yaml
# In .github/workflows/ci.yml
- run: npm run lint -- --max-warnings=0
```

**Expected Results**: No warnings ever merge.

**Pros**: Enforced.
**Cons**: Strict; may require immediate fixes.

---

**Best Solution - Auto-Fix with Pre-Commit**

**Implementation**: `lint-staged` runs `eslint --fix` on commit.

**Components**:

1. Husky + lint-staged.

**Code Example**:
// package.json

```json
{
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"]
  }
}
```

**Expected Results**: Most warnings auto-fixed.

**Pros**: Zero developer friction.
**Cons**: Some issues cannot auto-fix.

---

## 7. Best Practices Compliance - Score: 5/10 📋

### Issue 7.1: Legacy migration script is stale and high-blast-radius

**Evidence**:

- `scripts/migrate-strapi-to-sanity.ts:1-17` — writes published docs directly.
- `:8-10` — references `npm run migrate` which does not exist.
- `:24` — imports `qs` which is not a direct dependency.
- `:56-61` — uses write token.

**Good Solution - Archive the Script**

**Implementation**: Move to `scripts/archive/` and add a README explaining it is historical.

**Components**:

1. File move.

**Code Example**:

```shell
mkdir -p scripts/archive
mv scripts/migrate-strapi-to-sanity.ts scripts/archive/
cat > scripts/archive/README.md << 'EOF'
# Archived Scripts

These scripts are preserved for historical reference only.
Do not run them in production.
EOF
```

**Expected Results**: No accidental execution.

**Pros**: Safe.
**Cons**: Still in repo.

---

**Better Solution - Delete the Script**

**Implementation**: `git rm scripts/migrate-strapi-to-sanity.ts`.

**Components**:

1. Git delete.

**Code Example**:

```shell
git rm scripts/migrate-strapi-to-sanity.ts
git commit -m "Remove stale Strapi migration script"
```

**Expected Results**: Clean workspace.

**Pros**: Definitive.
**Cons**: Lost history (but in git history).

---

**Best Solution - Document Migration Runbook and Lock Write Tokens**

**Implementation**: If the script must be kept for reference, document when it was last used, lock the write token to specific IPs, and require MFA for schema deploys.

**Components**:

1. `docs/runbooks/migration.md`.
2. Sanity token IP restrictions.

**Code Example**:

```markdown
<!-- docs/runbooks/migration.md -->

# Migration Runbook

Last Migration Record

- Source: Strapi
- Destination: Sanity
- Script: `scripts/archive/migrate-strapi-to-sanity.ts`
- Approval: production-content-import approval record in the launch checklist

Security Notes

- Sanity write tokens are restricted to office IP ranges.
- Schema deploys require MFA.
- Migration scripts must be reviewed by two engineers before execution.
```

**Expected Results**: Write tokens are harder to misuse.

**Pros**: Secure.
**Cons**: Operational overhead.

---

### Issue 7.2: Consent drift: Speed Insights loads outside consent-gated analytics

**Evidence**:

- `src/components/analytics/consented-analytics.tsx:14-52` — gates Vercel Analytics behind consent.
- `src/app/layout.tsx:73-74` — always loads `<SpeedInsights />`.

**Good Solution - Gate SpeedInsights Behind Same Consent Check**

**Implementation**: Move `<SpeedInsights />` inside `ConsentedAnalytics` or add the same consent check.

**Components**:

1. `src/app/layout.tsx`.

**Code Example**:

```tsx
// src/components/analytics/consented-speed-insights.tsx
"use client";

import { useConsent } from "@/hooks/use-consent";
import { SpeedInsights } from "@vercel/speed-insights/next";

export function ConsentedSpeedInsights() {
  const { hasConsent } = useConsent("analytics");
  if (!hasConsent) return null;
  return <SpeedInsights />;
}

// src/app/layout.tsx
import { ConsentedSpeedInsights } from "@/components/analytics/consented-speed-insights";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <ConsentedSpeedInsights />
      </body>
    </html>
  );
}
```

**Expected Results**: SpeedInsights only loads with consent.

**Pros**: Consistent.
**Cons**: Slightly more complex layout.

---

**Better Solution - Separate Performance Consent from Marketing Consent**

**Implementation**: Add a "performance cookies" tier to the consent manager. SpeedInsights is performance, not marketing.

**Components**:

1. Consent manager update.
2. UI update for cookie banner.

**Code Example**:

```typescript
// src/lib/consent/types.ts
export type ConsentTier = "necessary" | "performance" | "marketing";

export interface ConsentState {
  necessary: true;
  performance: boolean;
  marketing: boolean;
}

// In cookie banner
const [consent, setConsent] = useState<ConsentState>({
  necessary: true,
  performance: false,
  marketing: false,
});
```

**Expected Results**: Granular consent.

**Pros**: User-friendly.
**Cons**: More UI complexity.

---

**Best Solution - Remove Third-Party Performance Tools, Use Native APIs**

**Implementation**: Replace Vercel SpeedInsights with `PerformanceObserver` and self-hosted beacon endpoint.

**Components**:

1. `src/lib/performance/self-hosted-beacon.ts`.
2. API route `/api/metrics`.

**Code Example**:

```typescript
// src/lib/performance/self-hosted-beacon.ts
export function initSelfHostedMetrics() {
  if (typeof window === "undefined") return;

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      fetch("/api/metrics", {
        method: "POST",
        body: JSON.stringify({
          name: entry.name,
          duration: entry.duration,
          type: entry.entryType,
          timestamp: Date.now(),
        }),
        keepalive: true,
      });
    }
  });

  observer.observe({ entryTypes: ["navigation", "resource"] });
}
```

**Expected Results**: No third-party dependency; full data ownership.

**Pros**: Privacy-first; no consent needed for first-party metrics.
**Cons**: Rebuilds what Vercel provides.

---

### Issue 7.3: Sanity schema validation is uneven for route/checkout/a11y-critical fields

**Evidence**:

- `src/sanity/schemas/documents/product.ts:203` — alt field optional.
- `src/sanity/schemas/documents/service.ts:100/120/131` — alt fields optional.
- `src/sanity/schemas/objects/layout/hero-section.ts:31/83` — alt fields optional.
- `src/sanity/schemas/documents/trainingProgram.ts` — custom validations exist but not all critical fields are required.

**Good Solution - Audit and Require Critical Fields**

**Implementation**: Review all schemas and add `Rule.required()` to fields that must exist for the page to function (e.g., title, slug, price, alt).

**Components**:

1. Schema file edits.

**Code Example**:

```typescript
// src/sanity/schemas/documents/product.ts
{
  name: "title",
  type: "string",
  validation: (Rule) => Rule.required().max(100),
},
{
  name: "slug",
  type: "slug",
  validation: (Rule) => Rule.required(),
},
{
  name: "price",
  type: "number",
  validation: (Rule) => Rule.required().min(0),
},
```

**Expected Results**: No incomplete content can be published.

**Pros**: Immediate quality improvement.
**Cons**: May break existing drafts.

---

**Better Solution - Add Schema Validation Tests**

**Implementation**: Write unit tests that instantiate each schema type and verify required fields.

**Components**:

1. `src/sanity/schemas/__tests__/schema-validation.test.ts`.

**Code Example**:

```typescript
// src/sanity/schemas/__tests__/schema-validation.test.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { product } from "../documents/product";

describe("product schema", () => {
  it("has required title", () => {
    const titleField = product.fields.find((f) => f.name === "title");
    assert.ok(titleField);
    assert.strictEqual(typeof titleField.validation, "function");
  });
});
```

**Expected Results**: Schema rules are code-reviewed and tested.

**Pros**: Prevents regression.
**Cons**: Maintenance overhead.

---

**Best Solution - Custom Validation Plugin with Editorial Guidance**

**Implementation**: Build a Sanity plugin that provides real-time editorial guidance (e.g., "This image is missing alt text. Add it for accessibility.") and blocks publish if critical fields are empty.

**Components**:

1. Sanity plugin.
2. Custom document actions.

**Code Example**:

```typescript
// src/sanity/plugins/editorial-guidance/index.ts
import { definePlugin } from "sanity";

export const editorialGuidancePlugin = definePlugin({
  name: "editorial-guidance",
  document: {
    badges: (prev, context) => {
      const missingAlt = context.document?.images?.some(
        (img: { alt?: string }) => !img.alt,
      );
      if (missingAlt) {
        return [
          ...prev,
          {
            label: "Missing alt text",
            color: "warning",
          },
        ];
      }
      return prev;
    },
  },
});
```

**Expected Results**: Editors are guided, not just blocked.

**Pros**: Best editorial UX.
**Cons**: Requires Sanity plugin development.

---

## OWASP Top 10 Compliance Summary

| OWASP Category                                      | Status  | Evidence                                                                                                                                                                  |
| --------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A01: Broken Access Control**                      | PARTIAL | No RBAC in API routes; booking/checkout are public but functional. No admin middleware found.                                                                             |
| **A02: Cryptographic Failures**                     | AT RISK | Google Calendar refresh token in plaintext KV. Checkout encryption key exists but rotation policy unknown. No TLS config in `next.config.ts` (relies on Vercel defaults). |
| **A03: Injection**                                  | PARTIAL | CMS links passed directly to href without centralized sanitization. No SQL injection risk (Drizzle ORM used). No NoSQL injection risk apparent.                           |
| **A04: Insecure Design**                            | AT RISK | Provider artifacts created before durable order. Side effects inline on user paths. No abuse controls.                                                                    |
| **A05: Security Misconfiguration**                  | AT RISK | Missing CSP, HSTS, X-Frame-Options. No `middleware.ts`. Missing security headers entirely.                                                                                |
| **A06: Vulnerable Components**                      | AT RISK | 22 moderate vulnerabilities in dependency chain. No automated patching.                                                                                                   |
| **A07: Identification and Authentication Failures** | N/A     | No user authentication system found. OAuth is for Google Calendar integration only.                                                                                       |
| **A08: Software and Data Integrity Failures**       | PARTIAL | No SRI on third-party scripts. Build relies on npm (no lockfile verification in CI because no CI).                                                                        |
| **A09: Security Logging and Monitoring Failures**   | AT RISK | Console-heavy logging. No structured observability. No alerting. No audit trail for mutations.                                                                            |
| **A10: Server-Side Request Forgery**                | PARTIAL | API routes call external providers (Helcim, Square, Google) with user-influenced data but no explicit SSRF allowlist.                                                     |

**Overall OWASP Assessment**: The application fails on 5 categories, is at risk on 4, and is partial on 2. This is not acceptable for a production e-commerce platform.

---

## Recommendations Priority Matrix

| Priority     | Effort | Issue                               | Category       | Recommended Solution                                |
| ------------ | ------ | ----------------------------------- | -------------- | --------------------------------------------------- |
| **CRITICAL** | Low    | 1.2 Missing CSP/headers             | Security       | Add static headers in `next.config.ts`              |
| **CRITICAL** | Low    | 1.7 Local secret hygiene            | Security       | Verify `.env.local` is ignored; add secret scanning |
| **CRITICAL** | Low    | 5.1 No CI/CD                        | DevOps         | Add basic GitHub Actions workflow                   |
| **CRITICAL** | Medium | 1.4 Google Calendar token plaintext | Security       | Encrypt token with AES-256-GCM                      |
| **CRITICAL** | Medium | 4.1 Missing alt requirements        | Accessibility  | Require alt in Sanity schemas                       |
| **CRITICAL** | Medium | 4.2 Carousel ignores reduced motion | Accessibility  | Respect `prefers-reduced-motion`                    |
| **HIGH**     | Low    | 1.3 CMS link sanitization           | Security       | Centralize `safeProtocol` in `SafeLink` component   |
| **HIGH**     | Low    | 3.4 Layout-triggering animations    | Performance    | Use `transform` instead of `width`                  |
| **HIGH**     | Low    | 6.4 Lint warnings                   | Testing        | Fix remaining warnings; enforce zero-warnings in CI |
| **HIGH**     | Low    | 5.4 Artifact hygiene                | DevOps         | Remove tracked tarballs and `.playwright-mcp` files |
| **HIGH**     | Medium | 1.1 Public endpoint abuse controls  | Security       | Implement KV token-bucket rate limiting             |
| **HIGH**     | Medium | 1.6 Dependency vulnerabilities      | Security       | Update patch versions; add `overrides`              |
| **HIGH**     | Medium | 2.1 Provider before durable order   | Architecture   | Reorder: write pending order first                  |
| **HIGH**     | Medium | 2.2 Inline payment side effects     | Architecture   | Return 200 to webhook immediately                   |
| **HIGH**     | Medium | 3.1 Postgres pool limits            | Performance    | Add explicit pool config                            |
| **HIGH**     | Medium | 4.3 Booking loading live region     | Accessibility  | Add `aria-live="polite"`                            |
| **HIGH**     | Medium | 4.4 No axe-core                     | Accessibility  | Add `@axe-core/playwright` spec                     |
| **HIGH**     | Medium | 5.2 Console-heavy logging           | DevOps         | Add structured JSON logging                         |
| **HIGH**     | Medium | 6.1 No coverage instrumentation     | Testing        | Add `c8` to test script                             |
| **HIGH**     | Medium | 6.2 Skipped/weak tests              | Testing        | Re-enable or delete skipped tests                   |
| **HIGH**     | Medium | 7.2 SpeedInsights consent drift     | Best Practices | Gate behind consent check                           |
| **HIGH**     | High   | 2.3 Heavy client shell              | Architecture   | Lazy load `ContactPopup` and cart                   |
| **HIGH**     | High   | 2.4 Static block registry           | Architecture   | Dynamic imports per block type                      |
| **HIGH**     | High   | 3.2 Booking availability fan-out    | Performance    | Cache availability results                          |
| **HIGH**     | High   | 3.3 Image/bundle optimization       | Performance    | Add Sanity widths and `srcSet`                      |
| **MEDIUM**   | Low    | 7.1 Stale migration script          | Best Practices | Delete or archive `migrate-strapi-to-sanity.ts`     |
| **MEDIUM**   | Low    | 7.3 Uneven schema validation        | Best Practices | Audit and require critical fields                   |
| **MEDIUM**   | Medium | 1.5 Input payload limits            | Security       | Add `content-length` checks to API routes           |
| **MEDIUM**   | Medium | 5.3 Backup/DR manual                | DevOps         | Automated backup validation cron                    |
| **MEDIUM**   | High   | 6.3 E2E not in CI                   | Testing        | Add Playwright to GitHub Actions                    |

---

## Limitations of This Review

1. **Dynamic analysis was not performed**: No runtime penetration testing, fuzzing, or dynamic application security testing (DAST) was conducted. All findings are based on static code analysis and build output.
2. **Infrastructure access was limited**: The review did not include access to Vercel dashboard settings, Sanity project ACLs, PostgreSQL roles, or Google Cloud IAM. Network-layer security (WAF, DDoS protection) was not evaluated.
3. **Dependency chain depth**: `npm audit` results were accepted at face value; individual vulnerability exploitability was not manually verified.
4. **Business logic correctness**: Payment flows, tax calculations, and booking logic were reviewed for structural patterns only. Financial accuracy and regulatory compliance (PCI-DSS, GDPR, CCPA) were not audited.
5. **Third-party service configurations**: Square, Helcim, Resend, and Google Calendar API configurations were not reviewed. Webhook endpoint security (signature verification, replay protection) was assumed based on code presence but not dynamically tested.
6. **Scope**: Only the provided file paths and evidence were evaluated. Files not mentioned in the evidence were not reviewed.
