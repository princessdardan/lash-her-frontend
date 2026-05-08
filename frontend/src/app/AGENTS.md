# APP ROUTER

## OVERVIEW

Routes are mostly async server components that fetch Sanity data through central loaders, then render CMS blocks.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Site shell | `layout.tsx`, `(site)/layout.tsx` | Root handles fonts/analytics; site layout handles header/footer/menu. |
| Public pages | `(site)/*/page.tsx` | Home/contact/gallery/training/training detail. |
| Server actions | `actions/form.ts` | Form submissions write to Sanity before email. |
| Webhooks | `api/revalidate/route.ts` | Sanity HMAC + tag revalidation. |
| Studio route | `studio/[[...tool]]/page.tsx` | Embedded Sanity Studio. |

## CONVENTIONS

- Page data comes from `loaders` in `@/data/loaders`; avoid ad hoc page-local GROQ.
- Pages return `notFound()` when required CMS documents are absent.
- Public pages use ISR (`revalidate = 1800`) where present.
- Dynamic route params use Next 16 style `params: Promise<{ slug: string }>` in training program pages.
- Home composes home blocks and training blocks with `BlockRenderer`.

## FORM PIPELINE

- Client forms validate with `@/lib/form-validation`.
- Server actions re-run validation before mutation.
- Sanity write failure blocks success and returns a generic error.
- Email sending happens after successful write and is intentionally non-blocking.

## REVALIDATION RULES

- `parseBody()` must read the raw request stream before any JSON parsing.
- `isValidSignature !== true` is a failure, including `null` when the secret is missing.
- Cache tags must stay aligned with `src/data/loaders.ts`.
- Use `revalidateTag(tag, { expire: 0 })` for immediate Next 16 invalidation.

## ANTI-PATTERNS

- Do not use legacy Pages API routes for revalidation.
- Do not expose webhook error details in response bodies.
- Do not let email failure roll back a successful Sanity form submission.
