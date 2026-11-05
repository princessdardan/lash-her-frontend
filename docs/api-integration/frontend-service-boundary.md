# Frontend service boundary: P2-04

Named server-only clients use the reviewed P2 candidate contracts, while published v1 artifacts and validators remain unchanged. The P2 candidate manifest pins committed Course and Community artifacts; `npm run contracts:check` verifies both bundles and generated type trees. `npm run contracts:p2:generate` regenerates only the P2 tree. Candidate integrity is source evidence, not a released/deployed certification.

## Authentication and transport

`createCourseClient()` separates public catalog, customer learner, course-editor and course-support operations. Public calls obtain workload proof without an application credential or customer lookup. Learner calls require the customer-access and Course-read flags, then read the dedicated active customer database session and mint only a Course-learner token with its immutable UUID. Staff calls require `courses:edit` or `courses:support`; database-backed owner permissions map to explicit API capabilities. Administrator and employee roles receive neither new capability by default. `community:moderate` similarly maps only an authorized active owner to `community-moderator`; it does not expose Community member/moderation functionality.

Each outbound request uses fresh Vercel workload proof from the current execution, the configured gateway HTTPS origin, a statically allowlisted service/method/path, bounded bytes/deadlines and no redirects. Incoming browser cookies, bearer headers, provider identifiers, request IDs or user assertions are never forwarded. A safe gateway request UUID is preserved for correlation when available; untrusted IDs and Retry-After values are discarded. Errors expose a fixed safe message/code and UUID, never provider bodies, schema diagnostics or credentials. A receiver401 after verified frontend authentication and fresh token minting is treated as service unavailability; an absent frontend customer session produces the sign-in-required response. The gateway's distinct fixed-message error envelope is separately validated so rate limits and pre-forward maintenance refusals retain their safe meaning without fabricating mutation uncertainty.

Gateway route metadata selects `course` or `community`; historical entries default to Course. Equal lifecycle paths do not imply a shared upstream. Community aliases require its explicitly configured private HTTPS origin; absent configuration refuses them without a Course fallback. Private TLS policies grant the gateway peer only the reviewed service paths and preserve independent enrollment-publisher, authority-reader and operational peers. Mux retains its single exact signature-authenticated webhook exception. The host release guard accepts only the exact private Community TLS target when configured.

## Browser handlers and caching

| Same-origin handler | Behavior |
| --- | --- |
| `GET /api/academy/catalog` | Public catalog pagination; only declared query keys, numeric bounds and one value per key. |
| `GET /api/academy/catalog/[slug]` | Public course metadata; bounded canonical slug segment. |
| `GET /api/academy/courses` | The authenticated customer's courses. |
| `GET /api/academy/courses/[courseId]` | Protected course curriculum. |
| `GET /api/academy/courses/[courseId]/lessons` | Protected course lesson list. |
| `GET /api/academy/lessons/[lessonId]` | Protected lesson content. |
| `GET /api/academy/lessons/[lessonId]/playback` | Fresh access-authorized playback data. |
| `GET /api/academy/progress` | Protected progress with only declared course/lesson filters. |
| `POST /api/academy/lessons/[lessonId]/progress` | Protected, bounded JSON mutation; exact configured Origin and `X-Lash-CSRF: 1` required, cross-site Fetch Metadata denied. |

The two public metadata responses use a 60-second shared freshness bound with a further 30-second stale recovery interval. Every private success and every error is private/no-store. Public calls never consult a customer session, so their responses cannot vary by account. Runtime response validation rejects undeclared object fields, including nested private data, without stripping or coercing. Composed curriculum schemas remain valid across their declared fields. Personal progress responses are additionally checked against the verified customer UUID. Explicit HEAD rejection prevents framework GET fallback from minting playback or retrieving protected content.

There is no arbitrary upstream path parameter or generic browser proxy. New free-enrollment, media and assessment operations extend named methods and exact handlers when their source contracts are integrated. Course authoring methods are available to server actions under explicit staff capabilities; authoring UI remains P2-09. Both `CUSTOMER_AUTH_ENABLED` and `INTEGRATION_CUSTOMER_ACCESS_ENABLED` are required for the customer login/session implementation. Course reads use their independent existing flag. Disabling new customer/checkout access does not disable durable lifecycle delivery.

## Mutation and lifecycle admission

Named Course mutation methods acquire new-work admission around the complete awaited identity/provider/database call, including direct action/helper callers. Deterministic documented denials settle before conversion to safe UI errors. Caught network, schema or server ambiguity marks the enclosing operation uncertain, preventing a false drain result.

`createAccountLifecycleClient({ receiver, mintServiceToken })` accepts only the internal dedicated lifecycle issuer callback. `deliverCommand()` validates the closed published command, uses its command UUID as the matching idempotency header, admits delivery as recovery, and checks the exact command/version receipt with accepted/duplicate status. Only allowlisted version/idempotency/deletion conflict codes survive for durable delivery policy. No bearer, export bytes or private profile is stored in a command/receipt.

The production callback is `() => mintLifecycleServiceToken(receiver)` from `lifecycle-service-jwt.ts`. It mints only the fixed issuer/audience/`frontend-account-lifecycle` subject and `iat`, `exp`, `jti`, with a 300-second maximum and the selected receiver's current HS256 key. Configure independent `COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET` and `COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET`; optional corresponding previous keys remain receiver-only verification material. The issuer validates previous-key strength/distinctness and refuses reuse across configured user/admin, provider, gateway, database and session secret namespaces or service rotation lists. It never accepts arbitrary claims or a browser-selected minting key.

`getCommunityExport(persistedExportCommand)` validates the committed Community response against the export command's customer UUID, command UUID and account version, rejects extra fields and enforces the private future expiry bound of at most 24 hours. It is an authenticated protected read, with the receiver's ordinary operational quota accounting. No browser handler exposes this service adapter. Frontend lifecycle orchestration, durable storage/worker, session revocation, authenticated assembly and Course-specific export binding belong to P2-11. The Course lifecycle gateway aliases are reserved against the published boundary until its committed receiver/export schema is integrated.

## Verification limits

Focused tests exercise real declared response shapes, composition, unknown/status rejection, session-derived subjects, separate staff capabilities, CSRF/identity/query refusal, public/private cache boundaries, mutation uncertainty, exact lifecycle replay binding, private export ownership/expiry and sanitized errors. Loopback TLS gateway tests verify selected service upstreams, independent admission/recovery, workload and application credentials, header isolation, private peer allowlists and the unchanged exact Mux exception. Host plan tests pin the optional Community origin. No provider is contacted and no live feature, admission policy, migration or deployment is enabled by these tests. P2-12 must qualify actual deployed provider/browser journeys and release bytes.
