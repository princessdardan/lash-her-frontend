# HelcimPay.js Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a custom Lash Her storefront checkout where Sanity/app catalog data drives sellable items and Helcim handles invoice creation plus HelcimPay.js payment processing.

**Architecture:** The first release uses Sanity as the catalog and order-reconciliation store, Next.js server routes for checkout/payment validation, and Helcim for invoice/payment records. The browser never receives Helcim credentials or response-validation secrets; it only receives a HelcimPay.js `checkoutToken` and forwards iframe events back to the server.

**Tech Stack:** Next.js 16 App Router, React 18, TypeScript strict, Sanity v4/next-sanity, Helcim v2 API, HelcimPay.js iframe script, Node `crypto`, Playwright E2E, `tsx --test` unit tests.

---

## First-release scope locked by this plan

- Catalog source: Sanity document type `sellableProduct`.
- Supported item kinds: `product`, `service`, `training`, and `deposit`.
- Currency: CAD only.
- Quantity: whole numbers from 1 to 10.
- Tax, discount, shipping, ACH, Fee Saver, partial payments, refunds, saved payment methods, and customer pre-linking are not in the first implementation.
- Helcim invoices contain line-item snapshots generated from validated Sanity catalog data.

If any of those choices are not acceptable, stop before Task 1 and revise this plan.

## File structure

### Create

- `frontend/src/sanity/schemas/documents/sellable-product.ts` — editable catalog records.
- `frontend/src/sanity/schemas/documents/checkout-order.ts` — local reconciliation records.
- `frontend/src/lib/commerce/money.ts` — CAD money helpers.
- `frontend/src/lib/commerce/cart.ts` — cart input parsing and validation helpers.
- `frontend/src/lib/commerce/helcim-types.ts` — Helcim request/response interfaces.
- `frontend/src/lib/commerce/helcim-client.ts` — server-only Helcim API wrapper.
- `frontend/src/lib/commerce/helcim-hash.ts` — response-hash validation.
- `frontend/src/lib/commerce/order-store.ts` — server-only Sanity order persistence helpers.
- `frontend/src/app/api/checkout/route.ts` — validates cart, creates order/invoice/session.
- `frontend/src/app/api/checkout/validate-payment/route.ts` — validates HelcimPay.js success payload.
- `frontend/src/components/commerce/helcim-pay-button.tsx` — client component that loads HelcimPay.js and opens/removes iframe.
- `frontend/src/components/commerce/product-card.tsx` — product display and add-to-cart UI.
- `frontend/src/components/commerce/cart-panel.tsx` — client cart state and checkout launcher.
- `frontend/src/app/(site)/shop/page.tsx` — public shop page.
- `frontend/src/app/(site)/shop/confirmation/page.tsx` — confirmation page.
- `frontend/src/lib/commerce/*.test.ts` — unit tests for pure commerce helpers.
- `frontend/tests/checkout.spec.ts` — browser flow tests with mocked Helcim endpoints/script.

### Modify

- `frontend/package.json` — add `test:unit` script.
- `frontend/src/types/index.ts` — add catalog/order TypeScript shapes.
- `frontend/src/sanity/schemas/index.ts` — register new document schemas.
- `frontend/src/sanity/structure/index.ts` — add Catalog and Orders sections.
- `frontend/src/data/loaders.ts` — add sellable product loaders and cache tags.
- `frontend/src/app/api/revalidate/route.ts` — revalidate `sellableProduct` cache tag.
- `frontend/src/sanity/env.ts` — add backend-only Helcim env assertions.
- `frontend/src/components/ui/mobile-navigation.tsx` or menu content in Sanity — add Shop navigation only if product launch requires it; otherwise leave navigation unchanged.

---

### Task 1: Add unit test runner

**Files:**
- Modify: `frontend/package.json`

- [ ] **Step 1: Add the unit test script**

In `frontend/package.json`, update `scripts` to include `test:unit` while keeping the existing Playwright `test` script:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "playwright test",
    "test:unit": "tsx --test \"src/**/*.test.ts\"",
    "test:ui": "playwright test --ui",
    "test:headed": "playwright test --headed",
    "test:debug": "playwright test --debug",
    "test:report": "playwright show-report",
    "migrate": "tsx scripts/migrate-strapi-to-sanity.ts"
  }
}
```

- [ ] **Step 2: Verify the unit runner has no tests yet**

Run from `frontend`:

```bash
npm run test:unit
```

Expected: the command exits 0 or reports no matching tests. If `tsx --test` errors because no files match, continue after Task 2 creates the first test.

- [ ] **Step 3: Commit**

```bash
git add frontend/package.json
git commit -m "test: add unit test runner"
```

---

### Task 2: Add commerce money and cart validation helpers with tests

**Files:**
- Create: `frontend/src/lib/commerce/money.ts`
- Create: `frontend/src/lib/commerce/cart.ts`
- Create: `frontend/src/lib/commerce/money.test.ts`
- Create: `frontend/src/lib/commerce/cart.test.ts`

- [ ] **Step 1: Write money helper tests**

Create `frontend/src/lib/commerce/money.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { addCad, formatCad, multiplyCad, parseCad } from "./money";

test("parseCad accepts two-decimal CAD amounts", () => {
  assert.equal(parseCad(125.5), 125.5);
  assert.equal(parseCad("125.50"), 125.5);
});

test("parseCad rejects negative or over-precise amounts", () => {
  assert.throws(() => parseCad(-1), /valid CAD amount/);
  assert.throws(() => parseCad("1.005"), /valid CAD amount/);
});

test("addCad and multiplyCad keep two decimal precision", () => {
  assert.equal(addCad([10.1, 2.2, 0.7]), 13);
  assert.equal(multiplyCad(19.99, 3), 59.97);
});

test("formatCad formats CAD for display", () => {
  assert.equal(formatCad(59.97), "$59.97 CAD");
});
```

- [ ] **Step 2: Run money tests to verify failure**

Run from `frontend`:

```bash
npm run test:unit -- src/lib/commerce/money.test.ts
```

Expected: FAIL with module-not-found for `./money`.

- [ ] **Step 3: Implement money helpers**

Create `frontend/src/lib/commerce/money.ts`:

```ts
const CAD_AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

export function parseCad(value: number | string): number {
  const normalized = typeof value === "number" ? value.toFixed(2) : value.trim();
  if (!CAD_AMOUNT_PATTERN.test(normalized)) {
    throw new Error("Expected a valid CAD amount with up to two decimal places");
  }

  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Expected a valid CAD amount with up to two decimal places");
  }

  return Number(amount.toFixed(2));
}

export function addCad(values: number[]): number {
  const cents = values.reduce((sum, value) => sum + Math.round(parseCad(value) * 100), 0);
  return cents / 100;
}

export function multiplyCad(amount: number, quantity: number): number {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error("Expected quantity to be a positive whole number");
  }

  return Math.round(parseCad(amount) * 100 * quantity) / 100;
}

export function formatCad(amount: number): string {
  return `$${parseCad(amount).toFixed(2)} CAD`;
}
```

- [ ] **Step 4: Write cart validation tests**

Create `frontend/src/lib/commerce/cart.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { buildValidatedCart, type CatalogProduct } from "./cart";

const product: CatalogProduct = {
  id: "product-1",
  sku: "LASH-CLASSIC",
  title: "Classic Lash Set",
  price: 125,
  currency: "CAD",
  isAvailable: true,
};

test("buildValidatedCart creates invoice-ready line items", () => {
  const cart = buildValidatedCart([{ productId: "product-1", quantity: 2 }], [product]);
  assert.deepEqual(cart.lineItems, [
    {
      sku: "LASH-CLASSIC",
      description: "Classic Lash Set",
      quantity: 2,
      price: 125,
      total: 250,
    },
  ]);
  assert.equal(cart.amount, 250);
  assert.equal(cart.currency, "CAD");
});

test("buildValidatedCart rejects missing products", () => {
  assert.throws(
    () => buildValidatedCart([{ productId: "missing", quantity: 1 }], [product]),
    /Product is no longer available/,
  );
});

test("buildValidatedCart rejects unavailable products", () => {
  assert.throws(
    () => buildValidatedCart([{ productId: "product-1", quantity: 1 }], [{ ...product, isAvailable: false }]),
    /Product is no longer available/,
  );
});

test("buildValidatedCart rejects invalid quantities", () => {
  assert.throws(
    () => buildValidatedCart([{ productId: "product-1", quantity: 11 }], [product]),
    /Quantity must be between 1 and 10/,
  );
});
```

- [ ] **Step 5: Run cart tests to verify failure**

Run from `frontend`:

```bash
npm run test:unit -- src/lib/commerce/cart.test.ts
```

Expected: FAIL with module-not-found for `./cart`.

- [ ] **Step 6: Implement cart validation**

Create `frontend/src/lib/commerce/cart.ts`:

```ts
import { addCad, multiplyCad, parseCad } from "./money";

export type CommerceCurrency = "CAD";

export interface CatalogProduct {
  id: string;
  sku: string;
  title: string;
  price: number;
  currency: CommerceCurrency;
  isAvailable: boolean;
}

export interface CartInputItem {
  productId: string;
  quantity: number;
}

export interface ValidatedCartLineItem {
  sku: string;
  description: string;
  quantity: number;
  price: number;
  total: number;
}

export interface ValidatedCart {
  currency: CommerceCurrency;
  amount: number;
  lineItems: ValidatedCartLineItem[];
}

export function buildValidatedCart(items: CartInputItem[], products: CatalogProduct[]): ValidatedCart {
  if (!items.length) {
    throw new Error("Cart must contain at least one item");
  }

  const productById = new Map(products.map((product) => [product.id, product]));
  const lineItems = items.map((item) => {
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) {
      throw new Error("Quantity must be between 1 and 10");
    }

    const product = productById.get(item.productId);
    if (!product?.isAvailable) {
      throw new Error("Product is no longer available");
    }

    const price = parseCad(product.price);
    return {
      sku: product.sku,
      description: product.title,
      quantity: item.quantity,
      price,
      total: multiplyCad(price, item.quantity),
    };
  });

  return {
    currency: "CAD",
    amount: addCad(lineItems.map((item) => item.total)),
    lineItems,
  };
}
```

- [ ] **Step 7: Run unit tests**

Run from `frontend`:

```bash
npm run test:unit -- src/lib/commerce/money.test.ts src/lib/commerce/cart.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/commerce/money.ts frontend/src/lib/commerce/cart.ts frontend/src/lib/commerce/money.test.ts frontend/src/lib/commerce/cart.test.ts
git commit -m "feat: add commerce cart validation helpers"
```

---

### Task 3: Add Sanity catalog and order schemas

**Files:**
- Create: `frontend/src/sanity/schemas/documents/sellable-product.ts`
- Create: `frontend/src/sanity/schemas/documents/checkout-order.ts`
- Modify: `frontend/src/sanity/schemas/index.ts`
- Modify: `frontend/src/sanity/structure/index.ts`
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/app/api/revalidate/route.ts`

- [ ] **Step 1: Create sellable product schema**

Create `frontend/src/sanity/schemas/documents/sellable-product.ts`:

```ts
import { defineField, defineType } from "sanity";

export const sellableProduct = defineType({
  name: "sellableProduct",
  title: "Sellable Product",
  type: "document",
  fields: [
    defineField({ name: "title", title: "Title", type: "string", validation: (Rule) => Rule.required() }),
    defineField({ name: "description", title: "Description", type: "text", validation: (Rule) => Rule.required() }),
    defineField({ name: "slug", title: "Slug", type: "slug", options: { source: "title" }, validation: (Rule) => Rule.required() }),
    defineField({ name: "sku", title: "SKU", type: "string", validation: (Rule) => Rule.required() }),
    defineField({
      name: "kind",
      title: "Kind",
      type: "string",
      initialValue: "service",
      options: {
        layout: "radio",
        list: [
          { title: "Product", value: "product" },
          { title: "Service", value: "service" },
          { title: "Training", value: "training" },
          { title: "Deposit", value: "deposit" },
        ],
      },
      validation: (Rule) => Rule.required(),
    }),
    defineField({ name: "price", title: "Price", type: "number", validation: (Rule) => Rule.required().min(0) }),
    defineField({ name: "currency", title: "Currency", type: "string", initialValue: "CAD", readOnly: true, validation: (Rule) => Rule.required() }),
    defineField({ name: "isAvailable", title: "Available for checkout", type: "boolean", initialValue: true, validation: (Rule) => Rule.required() }),
    defineField({ name: "image", title: "Image", type: "image", options: { hotspot: true }, fields: [{ name: "alt", title: "Alt text", type: "string" }] }),
  ],
  preview: {
    select: { title: "title", subtitle: "sku" },
  },
});
```

- [ ] **Step 2: Create checkout order schema**

Create `frontend/src/sanity/schemas/documents/checkout-order.ts`:

```ts
import { defineField, defineType } from "sanity";

export const checkoutOrder = defineType({
  name: "checkoutOrder",
  title: "Checkout Order",
  type: "document",
  liveEdit: true,
  fields: [
    defineField({ name: "orderId", title: "Order ID", type: "string", validation: (Rule) => Rule.required() }),
    defineField({
      name: "status",
      title: "Status",
      type: "string",
      initialValue: "pending",
      options: {
        layout: "radio",
        list: [
          { title: "Pending", value: "pending" },
          { title: "Paid", value: "paid" },
          { title: "Verification failed", value: "verification_failed" },
          { title: "Cancelled", value: "cancelled" },
          { title: "Refunded", value: "refunded" },
        ],
      },
      validation: (Rule) => Rule.required(),
    }),
    defineField({ name: "checkoutToken", title: "Checkout token", type: "string", readOnly: true }),
    defineField({ name: "secretToken", title: "Secret token", type: "string", readOnly: true }),
    defineField({ name: "helcimInvoiceId", title: "Helcim invoice ID", type: "number", readOnly: true }),
    defineField({ name: "helcimInvoiceNumber", title: "Helcim invoice number", type: "string", readOnly: true }),
    defineField({ name: "helcimTransactionId", title: "Helcim transaction ID", type: "string", readOnly: true }),
    defineField({ name: "customerName", title: "Customer name", type: "string", validation: (Rule) => Rule.required() }),
    defineField({ name: "customerEmail", title: "Customer email", type: "string", validation: (Rule) => Rule.required().email() }),
    defineField({ name: "amount", title: "Amount", type: "number", validation: (Rule) => Rule.required().min(0) }),
    defineField({ name: "currency", title: "Currency", type: "string", initialValue: "CAD", readOnly: true }),
    defineField({
      name: "lineItems",
      title: "Line items",
      type: "array",
      validation: (Rule) => Rule.required().min(1),
      of: [
        {
          type: "object",
          fields: [
            defineField({ name: "sku", title: "SKU", type: "string", validation: (Rule) => Rule.required() }),
            defineField({ name: "description", title: "Description", type: "string", validation: (Rule) => Rule.required() }),
            defineField({ name: "quantity", title: "Quantity", type: "number", validation: (Rule) => Rule.required().min(1) }),
            defineField({ name: "price", title: "Price", type: "number", validation: (Rule) => Rule.required().min(0) }),
            defineField({ name: "total", title: "Total", type: "number", validation: (Rule) => Rule.required().min(0) }),
          ],
        },
      ],
    }),
  ],
  preview: {
    select: { title: "orderId", subtitle: "status" },
  },
});
```

- [ ] **Step 3: Register schemas**

Modify `frontend/src/sanity/schemas/index.ts`:

```ts
import { sellableProduct } from "./documents/sellable-product";
import { checkoutOrder } from "./documents/checkout-order";
```

Add both to `schemaTypes` immediately after `trainingProgram`:

```ts
trainingProgram,
sellableProduct,
checkoutOrder,
contactForm,
generalInquiry,
```

- [ ] **Step 4: Add Studio sections**

Modify `frontend/src/sanity/structure/index.ts` so the Content section includes products and Orders appears before Submissions:

```ts
S.documentTypeListItem("trainingProgram").title("Training Programs"),
S.documentTypeListItem("sellableProduct").title("Sellable Products"),
```

Add an Orders section:

```ts
S.divider(),
S.listItem()
  .title("Orders")
  .child(
    S.list()
      .title("Orders")
      .items([
        S.documentTypeListItem("checkoutOrder").title("Checkout Orders"),
      ])
  ),
```

- [ ] **Step 5: Add public TypeScript types**

Modify `frontend/src/types/index.ts` near document types:

```ts
export type TSellableProductKind = "product" | "service" | "training" | "deposit";
export type TCheckoutOrderStatus = "pending" | "paid" | "verification_failed" | "cancelled" | "refunded";

export interface TSellableProduct {
  _id: string;
  title: string;
  description: string;
  slug: string;
  sku: string;
  kind: TSellableProductKind;
  price: number;
  currency: "CAD";
  isAvailable: boolean;
  image?: TSanityImage;
}

export interface TCheckoutOrderLineItem {
  sku: string;
  description: string;
  quantity: number;
  price: number;
  total: number;
}

export interface TCheckoutOrder {
  orderId: string;
  status: TCheckoutOrderStatus;
  helcimInvoiceId?: number;
  helcimInvoiceNumber?: string;
  helcimTransactionId?: string;
  customerName: string;
  customerEmail: string;
  amount: number;
  currency: "CAD";
  lineItems: TCheckoutOrderLineItem[];
}
```

- [ ] **Step 6: Add revalidation tag**

Modify `frontend/src/app/api/revalidate/route.ts`:

```ts
sellableProduct: "sellableProduct",
```

- [ ] **Step 7: Run lint**

Run from `frontend`:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/sanity/schemas/documents/sellable-product.ts frontend/src/sanity/schemas/documents/checkout-order.ts frontend/src/sanity/schemas/index.ts frontend/src/sanity/structure/index.ts frontend/src/types/index.ts frontend/src/app/api/revalidate/route.ts
git commit -m "feat: add checkout catalog schemas"
```

---

### Task 4: Add catalog loaders and shop page

**Files:**
- Modify: `frontend/src/data/loaders.ts`
- Create: `frontend/src/components/commerce/product-card.tsx`
- Create: `frontend/src/components/commerce/cart-panel.tsx`
- Create: `frontend/src/app/(site)/shop/page.tsx`

- [ ] **Step 1: Add catalog loaders**

Modify `frontend/src/data/loaders.ts` imports:

```ts
import type { TSellableProduct } from "@/types";
```

Add functions before `export const loaders`:

```ts
async function getSellableProducts(): Promise<TSellableProduct[]> {
  const query = groq`*[_type == "sellableProduct" && isAvailable == true] | order(title asc){
    _id,
    title,
    description,
    "slug": slug.current,
    sku,
    kind,
    price,
    currency,
    isAvailable,
    image{ asset, hotspot, crop, alt }
  }`;
  return client.fetch<TSellableProduct[]>(query, {}, { next: { tags: ["sellableProduct"] } });
}

async function getSellableProductsByIds(ids: string[]): Promise<TSellableProduct[]> {
  const query = groq`*[_type == "sellableProduct" && _id in $ids]{
    _id,
    title,
    description,
    "slug": slug.current,
    sku,
    kind,
    price,
    currency,
    isAvailable,
    image{ asset, hotspot, crop, alt }
  }`;
  return client.fetch<TSellableProduct[]>(query, { ids }, { next: { tags: ["sellableProduct"] } });
}
```

Add both to `loaders`:

```ts
getSellableProducts,
getSellableProductsByIds,
```

- [ ] **Step 2: Create product card**

Create `frontend/src/components/commerce/product-card.tsx`:

```tsx
"use client";

import type { TSellableProduct } from "@/types";
import { Button } from "@/components/ui/button";
import { formatCad } from "@/lib/commerce/money";

interface ProductCardProps {
  product: TSellableProduct;
  onAdd: (product: TSellableProduct) => void;
}

export function ProductCard({ product, onAdd }: ProductCardProps): React.ReactElement {
  return (
    <article className="rounded-lg border border-brand-red bg-white p-6 text-black shadow-sm">
      <p className="text-xs uppercase tracking-[0.2em] text-brand-red">{product.kind}</p>
      <h2 className="mt-2 text-2xl font-semibold">{product.title}</h2>
      <p className="mt-3 text-sm text-neutral-700">{product.description}</p>
      <p className="mt-4 text-lg font-medium">{formatCad(product.price)}</p>
      <Button className="mt-5" disabled={!product.isAvailable} onClick={() => onAdd(product)}>
        {product.isAvailable ? "Add to cart" : "Unavailable"}
      </Button>
    </article>
  );
}
```

- [ ] **Step 3: Create cart panel**

Create `frontend/src/components/commerce/cart-panel.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";

import type { TSellableProduct } from "@/types";
import { buildValidatedCart, type CartInputItem } from "@/lib/commerce/cart";
import { formatCad } from "@/lib/commerce/money";
import { Button } from "@/components/ui/button";
import { ProductCard } from "./product-card";
import { HelcimPayButton } from "./helcim-pay-button";

interface CartPanelProps {
  products: TSellableProduct[];
}

export function CartPanel({ products }: CartPanelProps): React.ReactElement {
  const [items, setItems] = useState<CartInputItem[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");

  const cart = useMemo(() => {
    if (!items.length) return null;
    return buildValidatedCart(items, products.map((product) => ({
      id: product._id,
      sku: product.sku,
      title: product.title,
      price: product.price,
      currency: product.currency,
      isAvailable: product.isAvailable,
    })));
  }, [items, products]);

  function addProduct(product: TSellableProduct): void {
    setItems((current) => {
      const existing = current.find((item) => item.productId === product._id);
      if (existing) {
        return current.map((item) => item.productId === product._id ? { ...item, quantity: Math.min(item.quantity + 1, 10) } : item);
      }
      return [...current, { productId: product._id, quantity: 1 }];
    });
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
      <div className="grid gap-6 md:grid-cols-2">
        {products.map((product) => <ProductCard key={product._id} product={product} onAdd={addProduct} />)}
      </div>
      <aside className="rounded-lg border border-brand-red bg-white p-6 shadow-sm">
        <h2 className="text-2xl font-semibold">Checkout</h2>
        <p className="mt-2 text-sm text-neutral-700" aria-live="polite">{items.length} item(s) in cart</p>
        <label className="mt-4 block text-sm font-medium" htmlFor="checkout-name">Name</label>
        <input id="checkout-name" className="mt-1 w-full rounded-md border px-3 py-2" value={customerName} onChange={(event) => setCustomerName(event.target.value)} />
        <label className="mt-4 block text-sm font-medium" htmlFor="checkout-email">Email</label>
        <input id="checkout-email" className="mt-1 w-full rounded-md border px-3 py-2" type="email" value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} />
        {cart ? <p className="mt-4 font-medium">Total: {formatCad(cart.amount)}</p> : <p className="mt-4 text-sm">Add an item to begin.</p>}
        <HelcimPayButton
          disabled={!cart || !customerName || !customerEmail}
          items={items}
          customer={{ name: customerName, email: customerEmail }}
          onPaid={() => setItems([])}
        />
        <Button className="mt-3 w-full" variant="outline" disabled={!items.length} onClick={() => setItems([])}>Clear cart</Button>
      </aside>
    </div>
  );
}
```

- [ ] **Step 4: Create shop page**

Create `frontend/src/app/(site)/shop/page.tsx`:

```tsx
import { loaders } from "@/data/loaders";
import { CartPanel } from "@/components/commerce/cart-panel";

export const revalidate = 300;

export default async function ShopPage(): Promise<React.ReactElement> {
  const products = await loaders.getSellableProducts();

  return (
    <main className="mx-auto max-w-6xl px-6 py-16">
      <p className="text-sm uppercase tracking-[0.25em] text-brand-red">Lash Her shop</p>
      <h1 className="mt-3 text-4xl font-semibold">Bookable services and training deposits</h1>
      <p className="mt-4 max-w-2xl text-neutral-700">Choose an available Lash Her offering and complete secure payment through Helcim.</p>
      <section className="mt-10">
        <CartPanel products={products} />
      </section>
    </main>
  );
}
```

- [ ] **Step 5: Run lint and unit tests**

Run from `frontend`:

```bash
npm run lint
npm run test:unit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/data/loaders.ts frontend/src/components/commerce/product-card.tsx frontend/src/components/commerce/cart-panel.tsx 'frontend/src/app/(site)/shop/page.tsx'
git commit -m "feat: add shop catalog page"
```

---

### Task 5: Add Helcim API client and response hash validation

**Files:**
- Create: `frontend/src/lib/commerce/helcim-types.ts`
- Create: `frontend/src/lib/commerce/helcim-client.ts`
- Create: `frontend/src/lib/commerce/helcim-hash.ts`
- Create: `frontend/src/lib/commerce/helcim-hash.test.ts`
- Modify: `frontend/src/sanity/env.ts`

- [ ] **Step 1: Add Helcim env helpers**

Modify `frontend/src/sanity/env.ts` to export backend-only getters:

```ts
export function getHelcimApiToken(): string {
  const token = process.env.HELCIM_API_TOKEN;
  if (!token) throw new Error("Missing env var: HELCIM_API_TOKEN");
  return token;
}
```

- [ ] **Step 2: Add Helcim types**

Create `frontend/src/lib/commerce/helcim-types.ts`:

```ts
import type { ValidatedCartLineItem } from "./cart";

export interface HelcimInvoiceRequest {
  currency: "CAD";
  lineItems: Array<Pick<ValidatedCartLineItem, "sku" | "description" | "quantity" | "price">>;
  type: "INVOICE";
  status: "DUE";
  notes: string;
}

export interface HelcimInvoiceResponse {
  invoiceId: number;
  invoiceNumber: string;
  token?: string;
}

export interface HelcimPayInitializeRequest {
  paymentType: "purchase";
  amount: number;
  currency: "CAD";
  invoiceNumber: string;
}

export interface HelcimPayInitializeResponse {
  checkoutToken: string;
  secretToken: string;
}

export interface HelcimPaySuccessPayload {
  data: Record<string, string | number | boolean | null>;
  hash: string;
}
```

- [ ] **Step 3: Add Helcim client**

Create `frontend/src/lib/commerce/helcim-client.ts`:

```ts
import "server-only";

import { getHelcimApiToken } from "@/sanity/env";
import type { HelcimInvoiceRequest, HelcimInvoiceResponse, HelcimPayInitializeRequest, HelcimPayInitializeResponse } from "./helcim-types";

const HELCIM_API_BASE_URL = "https://api.helcim.com/v2";

async function helcimFetch<TResponse>(path: string, init: RequestInit): Promise<TResponse> {
  const response = await fetch(`${HELCIM_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-token": getHelcimApiToken(),
      ...init.headers,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Helcim API request failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<TResponse>;
}

export async function createHelcimInvoice(request: HelcimInvoiceRequest): Promise<HelcimInvoiceResponse> {
  return helcimFetch<HelcimInvoiceResponse>("/invoices/", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function initializeHelcimPay(request: HelcimPayInitializeRequest): Promise<HelcimPayInitializeResponse> {
  return helcimFetch<HelcimPayInitializeResponse>("/helcim-pay/initialize", {
    method: "POST",
    body: JSON.stringify(request),
  });
}
```

- [ ] **Step 4: Write hash tests**

Create `frontend/src/lib/commerce/helcim-hash.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createHelcimResponseHash, validateHelcimResponseHash } from "./helcim-hash";

test("validateHelcimResponseHash accepts a matching hash", () => {
  const data = { transactionId: "abc123", amount: "125.00", status: "APPROVAL" };
  const secretToken = "secret-token";
  const hash = createHelcimResponseHash(data, secretToken);
  assert.equal(validateHelcimResponseHash(data, secretToken, hash), true);
});

test("validateHelcimResponseHash rejects a mismatched hash", () => {
  const data = { transactionId: "abc123", amount: "125.00", status: "APPROVAL" };
  assert.equal(validateHelcimResponseHash(data, "secret-token", "bad-hash"), false);
});
```

- [ ] **Step 5: Implement hash helper**

Create `frontend/src/lib/commerce/helcim-hash.ts`:

```ts
import { createHash, timingSafeEqual } from "node:crypto";

type HelcimHashValue = string | number | boolean | null;

function stableSerialize(data: Record<string, HelcimHashValue>): string {
  return Object.keys(data)
    .sort()
    .map((key) => `${key}=${String(data[key] ?? "")}`)
    .join("&");
}

export function createHelcimResponseHash(data: Record<string, HelcimHashValue>, secretToken: string): string {
  return createHash("sha256").update(`${stableSerialize(data)}${secretToken}`).digest("hex");
}

export function validateHelcimResponseHash(data: Record<string, HelcimHashValue>, secretToken: string, hash: string): boolean {
  const expected = createHelcimResponseHash(data, secretToken);
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(hash, "hex");
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
```

- [ ] **Step 6: Verify exact Helcim hash algorithm before implementation**

Before executing this task, re-open Helcim's validation docs and adjust `stableSerialize()` if their documented hash concatenation order differs:

```bash
open https://devdocs.helcim.com/docs/validate-helcimpayjs
```

Expected: implementation matches Helcim's documented validation formula exactly.

- [ ] **Step 7: Run tests**

Run from `frontend`:

```bash
npm run test:unit -- src/lib/commerce/helcim-hash.test.ts
npm run lint
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/sanity/env.ts frontend/src/lib/commerce/helcim-types.ts frontend/src/lib/commerce/helcim-client.ts frontend/src/lib/commerce/helcim-hash.ts frontend/src/lib/commerce/helcim-hash.test.ts
git commit -m "feat: add Helcim server client"
```

---

### Task 6: Add order persistence helpers

**Files:**
- Create: `frontend/src/lib/commerce/order-store.ts`

- [ ] **Step 1: Implement order store**

Create `frontend/src/lib/commerce/order-store.ts`:

```ts
import "server-only";

import { nanoid } from "nanoid";

import { writeClient } from "@/sanity/lib/write-client";
import type { ValidatedCart } from "./cart";

export interface CreatePendingOrderInput {
  customerName: string;
  customerEmail: string;
  checkoutToken: string;
  secretToken: string;
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
  cart: ValidatedCart;
}

export interface PendingOrderRecord {
  _id: string;
  orderId: string;
  secretToken: string;
}

export async function createPendingOrder(input: CreatePendingOrderInput): Promise<PendingOrderRecord> {
  const orderId = `lh-${nanoid(12)}`;
  const document = await writeClient.create({
    _type: "checkoutOrder",
    orderId,
    status: "pending",
    checkoutToken: input.checkoutToken,
    secretToken: input.secretToken,
    helcimInvoiceId: input.helcimInvoiceId,
    helcimInvoiceNumber: input.helcimInvoiceNumber,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    amount: input.cart.amount,
    currency: input.cart.currency,
    lineItems: input.cart.lineItems,
  });

  return { _id: document._id, orderId, secretToken: input.secretToken };
}

export async function markOrderPaid(orderId: string, helcimTransactionId: string): Promise<void> {
  await writeClient.patch({ query: '*[_type == "checkoutOrder" && orderId == $orderId][0]', params: { orderId } })
    .set({ status: "paid", helcimTransactionId })
    .commit();
}

export async function markOrderVerificationFailed(orderId: string): Promise<void> {
  await writeClient.patch({ query: '*[_type == "checkoutOrder" && orderId == $orderId][0]', params: { orderId } })
    .set({ status: "verification_failed" })
    .commit();
}

export async function getPendingOrderByCheckoutToken(checkoutToken: string): Promise<PendingOrderRecord | null> {
  return writeClient.fetch<PendingOrderRecord | null>(
    '*[_type == "checkoutOrder" && checkoutToken == $checkoutToken && status == "pending"][0]{ _id, orderId, secretToken }',
    { checkoutToken },
  );
}
```

- [ ] **Step 2: Run lint**

Run from `frontend`:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/commerce/order-store.ts
git commit -m "feat: add checkout order persistence"
```

---

### Task 7: Add checkout initialization API route

**Files:**
- Create: `frontend/src/app/api/checkout/route.ts`

- [ ] **Step 1: Create checkout route**

Create `frontend/src/app/api/checkout/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";

import { loaders } from "@/data/loaders";
import { buildValidatedCart, type CartInputItem } from "@/lib/commerce/cart";
import { createHelcimInvoice, initializeHelcimPay } from "@/lib/commerce/helcim-client";
import { createPendingOrder } from "@/lib/commerce/order-store";

interface CheckoutRequestBody {
  customer: { name: string; email: string };
  items: CartInputItem[];
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as CheckoutRequestBody;
    if (!body.customer?.name || !body.customer?.email || !Array.isArray(body.items)) {
      return NextResponse.json({ error: "Invalid checkout request" }, { status: 400 });
    }

    const productIds = body.items.map((item) => item.productId);
    const products = await loaders.getSellableProductsByIds(productIds);
    const cart = buildValidatedCart(
      body.items,
      products.map((product) => ({
        id: product._id,
        sku: product.sku,
        title: product.title,
        price: product.price,
        currency: product.currency,
        isAvailable: product.isAvailable,
      })),
    );

    const invoice = await createHelcimInvoice({
      currency: "CAD",
      type: "INVOICE",
      status: "DUE",
      notes: "Lash Her website checkout",
      lineItems: cart.lineItems.map(({ sku, description, quantity, price }) => ({ sku, description, quantity, price })),
    });

    const checkout = await initializeHelcimPay({
      paymentType: "purchase",
      amount: cart.amount,
      currency: "CAD",
      invoiceNumber: invoice.invoiceNumber,
    });

    const order = await createPendingOrder({
      customerName: body.customer.name,
      customerEmail: body.customer.email,
      checkoutToken: checkout.checkoutToken,
      secretToken: checkout.secretToken,
      helcimInvoiceId: invoice.invoiceId,
      helcimInvoiceNumber: invoice.invoiceNumber,
      cart,
    });

    return NextResponse.json({ checkoutToken: checkout.checkoutToken, orderId: order.orderId });
  } catch (error) {
    console.error("[checkout] Failed to initialize checkout:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Unable to start checkout" }, { status: 400 });
  }
}
```

- [ ] **Step 2: Run lint**

Run from `frontend`:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app/api/checkout/route.ts
git commit -m "feat: add checkout initialization route"
```

---

### Task 8: Add payment validation API route and client Helcim button

**Files:**
- Create: `frontend/src/app/api/checkout/validate-payment/route.ts`
- Create: `frontend/src/components/commerce/helcim-pay-button.tsx`
- Create: `frontend/src/app/(site)/shop/confirmation/page.tsx`

- [ ] **Step 1: Create payment validation route**

Create `frontend/src/app/api/checkout/validate-payment/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";

import { validateHelcimResponseHash } from "@/lib/commerce/helcim-hash";
import { getPendingOrderByCheckoutToken, markOrderPaid, markOrderVerificationFailed } from "@/lib/commerce/order-store";

interface ValidatePaymentBody {
  checkoutToken: string;
  data: Record<string, string | number | boolean | null>;
  hash: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json()) as ValidatePaymentBody;
  const order = await getPendingOrderByCheckoutToken(body.checkoutToken);

  if (!order) {
    return NextResponse.json({ error: "Checkout session not found" }, { status: 404 });
  }

  const isValid = validateHelcimResponseHash(body.data, order.secretToken, body.hash);
  if (!isValid) {
    await markOrderVerificationFailed(order.orderId);
    return NextResponse.json({ error: "Payment could not be verified" }, { status: 400 });
  }

  const transactionId = String(body.data.transactionId ?? body.data.id ?? "");
  if (!transactionId) {
    await markOrderVerificationFailed(order.orderId);
    return NextResponse.json({ error: "Payment response missing transaction ID" }, { status: 400 });
  }

  await markOrderPaid(order.orderId, transactionId);
  return NextResponse.json({ orderId: order.orderId });
}
```

- [ ] **Step 2: Create Helcim Pay button**

Create `frontend/src/components/commerce/helcim-pay-button.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import Script from "next/script";
import { useRouter } from "next/navigation";

import type { CartInputItem } from "@/lib/commerce/cart";
import { Button } from "@/components/ui/button";

declare global {
  interface Window {
    appendHelcimPayIframe?: (checkoutToken: string) => void;
    removeHelcimPayIframe?: () => void;
  }
}

interface HelcimPayButtonProps {
  disabled: boolean;
  items: CartInputItem[];
  customer: { name: string; email: string };
  onPaid: () => void;
}

interface CheckoutResponse {
  checkoutToken: string;
  orderId: string;
}

export function HelcimPayButton({ disabled, items, customer, onPaid }: HelcimPayButtonProps): React.ReactElement {
  const router = useRouter();
  const [scriptReady, setScriptReady] = useState(false);
  const [checkoutToken, setCheckoutToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!checkoutToken) return;

    async function handleMessage(event: MessageEvent): Promise<void> {
      const payload = event.data as { eventName?: string; eventStatus?: string; eventMessage?: unknown };
      if (payload.eventName !== `helcim-pay-js-${checkoutToken}`) return;

      if (payload.eventStatus === "ABORTED" || payload.eventStatus === "HIDE") {
        window.removeHelcimPayIframe?.();
        return;
      }

      if (payload.eventStatus !== "SUCCESS") return;

      const response = await fetch("/api/checkout/validate-payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkoutToken, ...(payload.eventMessage as object) }),
      });

      if (!response.ok) {
        setError("Payment could not be verified. Please contact Lash Her before retrying.");
        window.removeHelcimPayIframe?.();
        return;
      }

      const result = (await response.json()) as { orderId: string };
      onPaid();
      window.removeHelcimPayIframe?.();
      router.push(`/shop/confirmation?order=${encodeURIComponent(result.orderId)}`);
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [checkoutToken, onPaid, router]);

  async function startCheckout(): Promise<void> {
    setIsLoading(true);
    setError(null);

    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customer, items }),
    });

    setIsLoading(false);
    if (!response.ok) {
      setError("Unable to start checkout. Please review your cart and try again.");
      return;
    }

    const checkout = (await response.json()) as CheckoutResponse;
    setCheckoutToken(checkout.checkoutToken);
    window.appendHelcimPayIframe?.(checkout.checkoutToken);
  }

  return (
    <>
      <Script src="https://secure.helcim.app/helcim-pay/services/start.js" strategy="afterInteractive" onLoad={() => setScriptReady(true)} />
      <Button className="mt-5 w-full" disabled={disabled || !scriptReady || isLoading} onClick={startCheckout}>
        {isLoading ? "Preparing secure checkout" : "Pay securely with Helcim"}
      </Button>
      {error ? <p className="mt-3 text-sm text-red-700" role="alert">{error}</p> : null}
    </>
  );
}
```

- [ ] **Step 3: Create confirmation page**

Create `frontend/src/app/(site)/shop/confirmation/page.tsx`:

```tsx
interface ConfirmationPageProps {
  searchParams: Promise<{ order?: string }>;
}

export default async function ConfirmationPage({ searchParams }: ConfirmationPageProps): Promise<React.ReactElement> {
  const { order } = await searchParams;

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="text-sm uppercase tracking-[0.25em] text-brand-red">Payment received</p>
      <h1 className="mt-3 text-4xl font-semibold">Thank you for choosing Lash Her.</h1>
      <p className="mt-4 text-neutral-700">Your payment was verified and your order has been recorded.</p>
      {order ? <p className="mt-6 rounded-lg border border-brand-red bg-white p-4 text-sm">Order reference: {order}</p> : null}
    </main>
  );
}
```

- [ ] **Step 4: Run lint and unit tests**

Run from `frontend`:

```bash
npm run lint
npm run test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/api/checkout/validate-payment/route.ts frontend/src/components/commerce/helcim-pay-button.tsx 'frontend/src/app/(site)/shop/confirmation/page.tsx'
git commit -m "feat: validate Helcim checkout payments"
```

---

### Task 9: Add checkout E2E coverage

**Files:**
- Create: `frontend/tests/checkout.spec.ts`

- [ ] **Step 1: Write checkout browser tests**

Create `frontend/tests/checkout.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test.describe("Helcim checkout", () => {
  test("shows the shop page", async ({ page }) => {
    await page.goto("/shop");
    await expect(page.getByRole("heading", { name: /bookable services and training deposits/i })).toBeVisible();
    await expect(page.getByText(/checkout/i)).toBeVisible();
  });

  test("handles checkout initialization failure without clearing cart", async ({ page }) => {
    await page.route("**/api/checkout", async (route) => {
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Unable to start checkout" }) });
    });

    await page.goto("/shop");
    await page.getByRole("button", { name: /add to cart/i }).first().click();
    await page.getByLabel(/name/i).fill("Nataliea Test");
    await page.getByLabel(/email/i).fill("test@example.com");
    await page.getByRole("button", { name: /pay securely with helcim/i }).click();
    await expect(page.getByRole("alert")).toContainText(/unable to start checkout/i);
    await expect(page.getByText(/1 item/i)).toBeVisible();
  });

  test("sends success events to validation endpoint", async ({ page }) => {
    await page.addInitScript(() => {
      window.appendHelcimPayIframe = (checkoutToken: string) => {
        window.postMessage({
          eventName: `helcim-pay-js-${checkoutToken}`,
          eventStatus: "SUCCESS",
          eventMessage: { data: { transactionId: "txn_123" }, hash: "hash_123" },
        }, "*");
      };
      window.removeHelcimPayIframe = () => undefined;
    });

    await page.route("**/api/checkout", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ checkoutToken: "checkout_123", orderId: "lh-test" }) });
    });

    await page.route("**/api/checkout/validate-payment", async (route) => {
      const body = route.request().postDataJSON() as { checkoutToken: string };
      expect(body.checkoutToken).toBe("checkout_123");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ orderId: "lh-test" }) });
    });

    await page.goto("/shop");
    await page.getByRole("button", { name: /add to cart/i }).first().click();
    await page.getByLabel(/name/i).fill("Nataliea Test");
    await page.getByLabel(/email/i).fill("test@example.com");
    await page.getByRole("button", { name: /pay securely with helcim/i }).click();
    await expect(page).toHaveURL(/\/shop\/confirmation\?order=lh-test/);
  });
});
```

- [ ] **Step 2: Seed at least one sellable product in Sanity development data**

Use Sanity Studio at `/studio` or a one-off script to create one `sellableProduct` with:

```json
{
  "_type": "sellableProduct",
  "title": "Classic Lash Set Deposit",
  "description": "Deposit for a classic lash set appointment.",
  "slug": { "_type": "slug", "current": "classic-lash-set-deposit" },
  "sku": "LH-CLASSIC-DEPOSIT",
  "kind": "deposit",
  "price": 50,
  "currency": "CAD",
  "isAvailable": true
}
```

Expected: `/shop` renders at least one “Add to cart” button.

- [ ] **Step 3: Run checkout E2E test**

Run from `frontend`:

```bash
npx playwright test tests/checkout.spec.ts --project=chromium
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/tests/checkout.spec.ts
git commit -m "test: add checkout flow coverage"
```

---

### Task 10: Full verification

**Files:**
- No new files.

- [ ] **Step 1: Run diagnostics on changed TypeScript files**

Use LSP diagnostics for all changed `.ts` and `.tsx` files. Expected: zero errors.

- [ ] **Step 2: Run unit tests**

Run from `frontend`:

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 3: Run checkout E2E**

Run from `frontend`:

```bash
npx playwright test tests/checkout.spec.ts --project=chromium
```

Expected: PASS.

- [ ] **Step 4: Run lint**

Run from `frontend`:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 5: Run build**

Run from `frontend`:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit final fixes if verification required code changes**

If verification required fixes, commit only those changed files:

```bash
git add <changed-files>
git commit -m "fix: stabilize Helcim checkout flow"
```

If no files changed, skip this commit.

---

## Self-review

### Spec coverage

- Custom catalog plus Helcim invoices/payments: Tasks 3, 4, 7, and 8.
- Server-only Helcim API and token handling: Tasks 5, 7, and 8.
- Cart validation and stale-price rejection: Task 2 and Task 7.
- Invoice-first checkout: Task 7.
- Helcim iframe handling: Task 8.
- Hash validation and order status updates: Tasks 5, 6, and 8.
- Local reconciliation record: Tasks 3 and 6.
- Testing strategy: Tasks 2, 5, 9, and 10.
- Non-goals: plan does not use Helcim Invoice API as product/inventory source, does not call undocumented product endpoints, and does not use Helcim Online Checkout.

### Placeholder scan

The plan contains no `TBD`, no unspecified implementation steps, and no references to undefined functions without a task creating them.

### Type consistency

Shared names are consistent across tasks: `sellableProduct`, `checkoutOrder`, `TSellableProduct`, `TCheckoutOrder`, `CartInputItem`, `ValidatedCart`, `createHelcimInvoice`, `initializeHelcimPay`, `createPendingOrder`, `markOrderPaid`, and `validateHelcimResponseHash`.
