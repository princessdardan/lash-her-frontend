import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import type { Metadata } from "next";
import type { ReactElement } from "react";
import type { TLandingPage } from "@/types";

const require = createRequire(import.meta.url);
const page: TLandingPage = {
  _id: "campaign.founding",
  title: "Founding Membership",
  slug: "founding-membership",
  heading: "Become a founding member",
  description: "Opening soon.",
  seo: {
    title: "New salon founding list",
    description: "Get opening updates.",
    noIndex: true,
  },
};

async function loadRoute() {
  const result = await build({
    entryPoints: ["src/app/(site)/[slug]/page.tsx"],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    external: ["react/jsx-runtime"],
    plugins: [
      {
        name: "route-dependencies",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^(next\/navigation|@\/data\/loaders|@\/components\/custom\/landing-page-content)$/,
            },
            (args) => ({ path: args.path, namespace: "fixture" }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: "fixture" },
            ({ path: name }) => ({
              contents:
                name === "next/navigation"
                  ? `export function notFound() { throw new Error('NEXT_NOT_FOUND'); }`
                  : name === "@/data/loaders"
                    ? `const page = ${JSON.stringify(page)}; export const loaders = { getLandingPageBySlug: async slug => slug === page.slug ? page : null };`
                    : `export function LandingPageContent() { return null; }`,
              loader: "js",
            }),
          );
        },
      },
    ],
  });
  const compiled = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(
    require,
    compiled,
    compiled.exports,
  );
  return compiled.exports as {
    default: (props: {
      params: Promise<{ slug: string }>;
    }) => Promise<ReactElement<{ page: TLandingPage }>>;
    generateMetadata: (props: {
      params: Promise<{ slug: string }>;
    }) => Promise<Metadata>;
  };
}

test("newly published landing slug resolves without a build-time slug list", async () => {
  const route = await loadRoute();
  const element = await route.default({
    params: Promise.resolve({ slug: page.slug }),
  });
  assert.deepEqual(element.props.page, page);
  const metadata = await route.generateMetadata({
    params: Promise.resolve({ slug: page.slug }),
  });
  assert.equal(metadata.title, page.seo!.title);
  assert.equal(metadata.description, page.seo!.description);
  assert.deepEqual(metadata.alternates, { canonical: "/founding-membership" });
  assert.deepEqual(metadata.robots, { index: false, follow: true });
});

test("unknown and reserved landing paths return notFound for content and metadata", async () => {
  const route = await loadRoute();
  for (const slug of ["missing-page", "studio", "booking", "bad--slug"]) {
    const props = { params: Promise.resolve({ slug }) };
    await assert.rejects(() => route.default(props), /NEXT_NOT_FOUND/);
    await assert.rejects(() => route.generateMetadata(props), /NEXT_NOT_FOUND/);
  }
});
