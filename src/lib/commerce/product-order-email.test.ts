import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { buildProductOrderConfirmationHtml } from "./src/lib/commerce/product-order-email.ts";
`;

test("product order confirmation email includes escaped order details", () => {
  runProductOrderEmailScenario(`
    const html = buildProductOrderConfirmationHtml({
      currency: "CAD",
      customerEmail: "client@example.com",
      customerName: "Client <Name> & Co",
      lineItems: [
        {
          description: "Signature <Lash> Set",
          productId: "signature-lash-set",
          quantity: 1,
          sku: "LASH-&-SIGNATURE",
          totalCents: 100000,
          unitPriceCents: 100000,
        },
        {
          description: "Aftercare Kit",
          productId: "aftercare-kit",
          quantity: 2,
          sku: "CARE-KIT",
          totalCents: 13000,
          unitPriceCents: 6500,
        },
      ],
      orderId: "lh-order-<123>",
      shippingAddress: {
        line1: "646 <Oakwood> Avenue",
        line2: "Suite & Studio",
        city: "Toronto",
        province: "Ontario",
        postalCode: "M6E 2Y4",
        country: "Canada",
      },
      totalAmount: 1130,
    });

    assert.match(html, /Your order is confirmed/);
    assert.match(html, /Client &lt;Name&gt; &amp; Co/);
    assert.match(html, /Signature &lt;Lash&gt; Set/);
    assert.equal(html.includes("LASH-&amp;-SIGNATURE"), false);
    assert.equal(html.includes("CARE-KIT"), false);
    assert.match(html, /Order lh-order-&lt;123&gt;/);
    assert.match(html, /Shipping to/);
    assert.match(html, /646 &lt;Oakwood&gt; Avenue/);
    assert.match(html, /Suite &amp; Studio/);
    assert.equal(html.includes("$1,130.00"), true);
    assert.match(html, /Aftercare Kit/);
    assert.equal(html.includes(">2</td>"), true);
    assert.equal(html.includes("Client <Name> & Co"), false);
    assert.equal(html.includes("Signature <Lash> Set"), false);
    assert.equal(html.includes("646 <Oakwood> Avenue"), false);
  `);
});

function runProductOrderEmailScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
