# SANITY

## OVERVIEW

Embedded Sanity Studio, schema registry, client separation, and Studio singleton structure live here.

## STRUCTURE

```text
src/sanity/
├── sanity.config.ts        # Studio config, singleton action/template filters
├── env.ts                  # public env assertions + lazy webhook secret
├── lib/                    # read, write, legacy/conditional form clients
├── schemas/                # documents, layout objects, shared objects
└── structure/              # custom Studio navigation
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add document type | `schemas/documents`, `schemas/index.ts` | Register manually. |
| Add layout block | `schemas/objects/layout` | Also update types/loaders/component registry. |
| Add shared object | `schemas/objects/shared` | Register in `schemaTypes`. |
| Change Studio nav | `structure/index.ts` | Singleton pages are manually listed. |
| Change singleton behavior | `sanity.config.ts`, `structure/index.ts` | Keep singleton sets and document IDs aligned. |
| Change clients/env | `env.ts`, `lib/*.ts` | Preserve server-only mutation clients. |

## CONVENTIONS

- Singleton document IDs match schema type names.
- `structureTool` from `sanity/structure` is used; do not use deprecated desk tooling.
- `schemaTypes` is manual, grouped as documents, layout blocks, shared objects, navigation objects.
- Read client uses CDN; write clients and any legacy/conditional form client are server-only and `useCdn: false`.
- Schema field names are the source of truth for GROQ projections and `src/types/index.ts`.

## COUPLING RULES

- Adding a singleton page usually touches schema registration, Studio structure, loaders, page route, metadata/revalidation tags, and TS types.
- Adding a renderable block touches schema, `TLayoutBlock`, loader projection, component, and `COMPONENT_REGISTRY`.
- Registered schemas are not necessarily rendered; verify registry/type support before relying on them.

## ANTI-PATTERNS

- Do not create duplicate singleton templates; `sanity.config.ts` intentionally filters them out.
- Do not bypass dedicated Sanity clients for mutations, and do not use Sanity clients for new private form/contact/consent writes.
- Do not assume Strapi shapes (`__component`, envelopes, implicit image spreads) apply here.
