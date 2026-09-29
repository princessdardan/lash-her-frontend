import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const requireFromTsx = createRequire(require.resolve("tsx"));
const { build } = requireFromTsx("esbuild") as typeof import("esbuild");
let bundle: string;
let markup: string;
let css: string;

test.beforeAll(async () => {
  const fixture = path.resolve("tests/fixtures/header-scroll-harness.tsx");
  for (const server of [true, false]) {
    const result = await build({
      stdin: {
        contents: server
          ? `import { renderToString } from 'react-dom/server'; import { Harness } from ${JSON.stringify(fixture)}; export const markup = renderToString(<Harness />);`
          : `import { hydrateRoot } from 'react-dom/client'; import { Harness } from ${JSON.stringify(fixture)}; hydrateRoot(document.getElementById('root'), <Harness />);`,
        loader: "tsx",
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      platform: server ? "node" : "browser",
      format: server ? "cjs" : "iife",
      jsx: "automatic",
      external: server
        ? ["react", "react-dom/server", "react/jsx-runtime"]
        : [],
      define: { "process.env.NODE_ENV": '"development"' },
      plugins: [
        {
          name: "pathname-fixture",
          setup(builder) {
            builder.onResolve({ filter: /^next\/navigation$/ }, () => ({
              path: "router",
              namespace: "fixture",
            }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents: server
                ? `export const usePathname = () => '/server-home';`
                : `import { useSyncExternalStore } from 'react'; const subscribe = cb => { addEventListener('popstate', cb); return () => removeEventListener('popstate', cb); }; export const usePathname = () => useSyncExternalStore(subscribe, () => location.pathname, () => location.pathname);`,
              resolveDir: process.cwd(),
              loader: "js",
            }));
          },
        },
      ],
    });
    if (server) {
      const output = { exports: {} as { markup: string } };
      new Function("require", "module", "exports", result.outputFiles[0].text)(
        require,
        output,
        output.exports,
      );
      markup = output.exports.markup;
    } else bundle = result.outputFiles[0].text;
  }
  const from = path.resolve("src/app/globals.css");
  css = (
    await postcss([tailwind()]).process(await fs.readFile(from, "utf8"), {
      from,
    })
  ).css;
});

async function openHarness(page: Page, pathname = "/", restoredScroll = 0) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<style>${css}</style><div id="root">${markup}</div>`,
    }),
  );
  await page.goto(`http://header.test${pathname}`);
  if (restoredScroll)
    await page.evaluate((y) => window.scrollTo(0, y), restoredScroll);
  await page.addScriptTag({ content: bundle });
  await expect(page.locator("body")).toHaveAttribute("data-hydrated", "true");
  return errors;
}

for (const width of [375, 1512]) {
  test(`homepage hydration and repeated scroll preserve contrast at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const errors = await openHarness(page);
    const header = page.locator("header");
    for (let cycle = 0; cycle < 2; cycle++) {
      await expect(page.locator("main")).toHaveCSS("padding-top", "0px");
      await expect(header).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(header.locator("span")).toHaveCSS(
        "color",
        "rgb(255, 255, 255)",
      );
      await expect
        .poll(() =>
          page
            .locator("main section")
            .first()
            .evaluate((el) => el.getBoundingClientRect().top),
        )
        .toBe(0);
      await page.evaluate(() => window.scrollTo(0, 700));
      await expect(header).toHaveCSS("background-color", "rgb(255, 255, 255)");
      await expect(header.locator("span")).toHaveCSS(
        "color",
        "rgb(28, 19, 24)",
      );
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    await expect(header).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    expect(errors).toEqual([]);
  });
}

test("restored scroll and client navigation keep header and spacing aligned", async ({
  page,
}) => {
  const errors = await openHarness(page, "/", 700);
  const header = page.locator("header");
  await expect(header).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(header.locator("span")).toHaveCSS("color", "rgb(28, 19, 24)");
  await page.evaluate(() => {
    history.pushState({}, "", "/services");
    dispatchEvent(new PopStateEvent("popstate"));
    window.scrollTo(0, 0);
  });
  await expect(page.locator("main")).toHaveCSS("padding-top", "112px");
  await expect(header).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.evaluate(() => {
    history.pushState({}, "", "/");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.locator("main")).toHaveCSS("padding-top", "0px");
  await expect(header).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect(errors).toEqual([]);
});
