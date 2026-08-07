import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("root layout is static and site layout retains CMS preview behavior", () => {
  const rootLayout = readFileSync(join(root, "src/app/layout.tsx"), "utf8");
  const siteLayout = readFileSync(
    join(root, "src/app/(site)/layout.tsx"),
    "utf8",
  );

  assert.doesNotMatch(
    rootLayout,
    /@\/data\/loaders|draftMode|VisualEditing|next-sanity/,
  );
  assert.match(rootLayout, /export const metadata/);
  assert.match(siteLayout, /@\/data\/loaders/);
  assert.match(siteLayout, /draftMode/);
  assert.match(siteLayout, /VisualEditing/);
  assert.match(siteLayout, /generateMetadata/);
});

test("academy layout blocks indexing and academy source stays isolated", () => {
  const layout = readFileSync(
    join(root, "src/app/(academy)/academy/layout.tsx"),
    "utf8",
  );
  assert.match(layout, /follow: false/);
  assert.match(layout, /index: false/);

  const academyFiles = [
    ...typescriptFiles(join(root, "src/lib/academy")),
    ...typescriptFiles(join(root, "src/components/academy")),
    ...typescriptFiles(join(root, "src/app/(academy)")),
    ...typescriptFiles(join(root, "src/app/api/academy")),
  ];
  const source = academyFiles
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /@\/data\/loaders|next-sanity|@\/sanity/);
  assert.doesNotMatch(source, /@\/lib\/commerce|@\/components\/commerce/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});

test("disabled academy routes stop before authentication or database work", () => {
  for (const relativePath of [
    "src/app/(academy)/academy/(protected)/layout.tsx",
    "src/app/(academy)/academy/sign-in/page.tsx",
    "src/app/(academy)/academy/sign-in/actions.ts",
  ]) {
    const source = readFileSync(join(root, relativePath), "utf8");
    const enabledGate = source.indexOf("getAcademyConfig().enabled");
    const authentication = Math.max(
      source.indexOf("requireAcademyPagePrincipal("),
      source.indexOf("auth()"),
      source.indexOf('signIn("google"'),
    );

    assert.ok(enabledGate >= 0, `${relativePath} must gate Academy access`);
    assert.ok(
      authentication < 0 || enabledGate < authentication,
      `${relativePath} must check the Academy flag before authentication`,
    );
  }
});

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? typescriptFiles(path)
      : /\.(ts|tsx)$/.test(name)
        ? [path]
        : [];
  });
}
