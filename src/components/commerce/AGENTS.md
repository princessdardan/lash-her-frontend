# COMMERCE COMPONENTS

## OVERVIEW

Client and server UI for product catalog browsing, cart state, Helcim checkout launch, product details, and training purchase CTAs.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Cart drawer | `cart-panel.tsx` | Client cart UX and checkout start. |
| Product cards | `product-card.tsx`, `product-card.test.ts` | Product listing item and interaction coverage. |
| Catalog controls | `product-catalog-shell.tsx`, `product-filters.tsx`, `product-sort.tsx` | Product filtering/sorting UI. |
| Product detail | `product-detail-sections.tsx`, `product-variant-selector.tsx` | Detail-page commerce presentation. |
| Helcim buttons | `helcim-pay-button.tsx`, `training-helcim-pay-button.tsx` | Payment launch surfaces. |
| Training purchase | `training-purchase-card.tsx` | Paid training checkout CTA state. |

## CONVENTIONS

- Keep product/checkout copy in quiet luxury brand tone; avoid generic ecommerce urgency patterns.
- Components call app API surfaces for checkout; they do not call Helcim or private DB code directly.
- Validate visual changes in a browser at desktop and mobile widths.
- Prefer semantic controls and labels; tests target user-facing behavior rather than implementation details.
- Use shared product/cart types from loaders and commerce helpers instead of redefining product shapes locally.

## ANTI-PATTERNS

- Do not leak Helcim secret tokens, transaction identifiers, or private order data into component state beyond the checkout token needed by Helcim Pay.
- Do not duplicate cart validation rules in UI as a source of truth; server checkout rebuilds the cart.
- Do not introduce loud sale-badge styling or generic pink beauty-store visuals.
