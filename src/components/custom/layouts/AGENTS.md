# CMS LAYOUT BLOCKS

## OVERVIEW

CMS-driven layout components render Sanity blocks through a centralized `_type` registry with error-boundary and animation wrappers.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Registry | `block-renderer.tsx` | `COMPONENT_REGISTRY`, non-renderable set, animation skip set. |
| Component shell | `*.tsx` in this directory | Most receive `{ data }` matching a `T*` block type. |
| Error handling | `block-error-boundary.tsx` | Preserves page render when a block fails. |
| Animation | `block-animation-wrapper.tsx` | Scroll entrance wrapper; hero skips animation. |
| Images | `../sanity-image.tsx` | Central Sanity image behavior. |

## CONVENTIONS

- Registry keys must match Sanity `_type` strings exactly.
- Stable block keys prefer Sanity `_key`, then index fallback.
- Unknown block types return `null` and warn only in development.
- `heroSection` skips entrance animation.
- `generalInquiryLabels` is intentionally non-renderable in generic block rendering.
- Design styling must follow `docs/lash-her-brand-kit.html` from repo root.

## ADDING A BLOCK

1. Add Sanity schema in `src/sanity/schemas/objects/layout`.
2. Add matching TypeScript interface/union member in `src/types/index.ts`.
3. Project fields in `src/data/loaders.ts` for every page that can use it.
4. Add component here with a typed `{ data }` prop.
5. Register `_type` in `COMPONENT_REGISTRY` unless intentionally non-renderable.

## ANTI-PATTERNS

- Do not render schema-registered blocks before their GROQ projection includes required fields.
- Do not remove wrappers casually; error boundaries and animation behavior are part of the block contract.
- Do not add broad client boundaries unless a block needs interactivity/animation/browser APIs.
