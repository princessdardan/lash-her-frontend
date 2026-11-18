import fs from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

let bundle: string;
let css: string;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { LandingPageContent } from '@/components/custom/landing-page-content';
        import { ContactPopup } from '@/components/custom/contact-popup/contact-popup';
        const page = {
          _id: 'landing.founding', title: 'Founding Membership', slug: 'founding-membership',
          eyebrow: 'A new chapter', heading: 'Become a founding member',
          description: 'Our new salon is coming. Join the founding membership interest list.',
          signup: { heading: 'Join the founding list', submitLabel: 'Join the founding list',
            successMessage: "You're on the founding list.", privacyPolicySlug: 'privacy' },
          body: [{ _type: 'block', _key: 'benefits', style: 'normal',
            children: [{ _type: 'span', _key: 'text', text: 'Hear about membership benefits and opening updates.', marks: [] }] }],
        };
        createRoot(document.getElementById('root')).render(<>
          <LandingPageContent page={page} />
          <ContactPopup settings={{ enabled: true, variant: 'emailOnly' }} excludedPaths={['/founding-membership']} />
        </>);
      `,
      loader: "tsx",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"development"',
      "process.env.NEXT_PUBLIC_SANITY_PROJECT_ID": '"test-project"',
      "process.env.NEXT_PUBLIC_SANITY_DATASET": '"test"',
      "process.env": "{}",
    },
    plugins: [
      {
        name: "landing-fixtures",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^(@\/app\/actions\/(landing-page|form)|next\/(navigation|link|image))$/,
            },
            (args) => ({ path: args.path, namespace: "fixture" }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: "fixture" },
            ({ path: name }) => ({
              contents:
                name === "@/app/actions/landing-page"
                  ? `export async function submitLandingPageSignup(input) { const response = await fetch('/signup', { method: 'POST', body: JSON.stringify(input) }); return response.json(); }`
                  : name === "@/app/actions/form"
                    ? `export async function submitContactPopup() { throw new Error('Unexpected popup submission'); }`
                    : name === "next/navigation"
                      ? `export const usePathname = () => location.pathname;`
                      : name === "next/link"
                        ? `import React from 'react'; export default function Link(props) { return <a {...props} />; }`
                        : `import React from 'react'; export default function Image({ fill, priority, ...props }) { return <img {...props} />; }`,
              loader: "jsx",
              resolveDir: process.cwd(),
            }),
          );
        },
      },
    ],
  });
  bundle = result.outputFiles[0].text;
  const from = path.resolve("src/app/globals.css");
  css = (
    await postcss([tailwind()]).process(await fs.readFile(from, "utf8"), {
      from,
    })
  ).css;
});

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://landing.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<style>${css}</style><main id="root"></main>`,
    }),
  );
  await page.goto(
    "http://landing.test/founding-membership?utm_campaign=salon-opening",
  );
  await page.addScriptTag({ content: bundle });
  await expect.poll(() => errors).toEqual([]);
  await expect(
    page.getByRole("heading", { name: "Become a founding member" }),
  ).toBeVisible();
}

for (const width of [375, 1440]) {
  test(`landing signup requires contact details and consent, then submits with attribution at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const requests: Record<string, unknown>[] = [];
    await open(page);
    await page.screenshot({
      path: testInfo.outputPath(`landing-${width}.png`),
      fullPage: true,
    });
    await page.route("http://landing.test/signup", async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ json: { success: true } });
    });
    await expect(
      page.getByRole("link", { name: "Privacy Policy" }),
    ).toHaveAttribute("href", "/policies/privacy");
    const submit = page.getByRole("button", { name: "Join the founding list" });
    await page.getByLabel("Email address").fill("person@example.com");
    await submit.click();
    expect(requests).toHaveLength(0);
    await page.getByRole("checkbox").check();
    await submit.click();
    expect(requests).toHaveLength(0);
    await page.getByLabel("Full name").fill("Jamie O’Neil");
    await submit.click();
    expect(requests).toHaveLength(0);
    await page.getByLabel("Phone number").fill("(416) 555-0123");
    await page.getByRole("checkbox").uncheck();
    await submit.click();
    expect(requests).toHaveLength(0);
    await page.getByRole("checkbox").check();
    await submit.click();
    await expect(page.getByRole("status")).toHaveText(
      "You're on the founding list.",
    );
    expect(requests).toEqual([
      {
        slug: "founding-membership",
        name: "Jamie O’Neil",
        email: "person@example.com",
        phone: "(416) 555-0123",
        company: "",
        marketingConsent: true,
        attribution: { utm_campaign: "salon-opening" },
      },
    ]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("server and connection errors leave the form usable for retry", async ({
  page,
}) => {
  await open(page);
  let attempts = 0;
  await page.route("http://landing.test/signup", async (route) => {
    attempts++;
    if (attempts === 1) return route.abort();
    if (attempts === 2)
      return route.fulfill({
        json: {
          success: false,
          fieldErrors: { phone: "Enter a valid phone number." },
        },
      });
    await route.fulfill({ json: { success: true } });
  });
  await page.getByLabel("Full name").fill("Jamie O’Neil");
  await page.getByLabel("Email address").fill("person@example.com");
  await page.getByLabel("Phone number").fill("123");
  await page.getByRole("checkbox").check();
  const submit = page.getByRole("button", { name: "Join the founding list" });
  await submit.click();
  await expect(page.getByRole("alert")).toContainText("We couldn't connect");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Enter a valid phone number.",
  );
  await page.getByLabel("Phone number").fill("(416) 555-0123");
  await submit.click();
  await expect(page.getByRole("status")).toBeVisible();
});

test("global signup popup stays suppressed on a landing page", async ({
  page,
}) => {
  await open(page);
  await page.waitForTimeout(3200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Email address")).toBeVisible();
});
