import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

test("admin authentication remains Auth.js based with no Clerk runtime dependency", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  assert.equal(packageJson.dependencies?.["next-auth"], "5.0.0-beta.31");
  assert.deepEqual(
    Object.keys(dependencies).filter((name) => name.toLowerCase().includes("clerk")),
    [],
  );

  const lockfile = await readFile(path.join(root, "package-lock.json"), "utf8");
  assert.doesNotMatch(lockfile, /node_modules\/@clerk\//i);

  const runtimeFiles = [
    path.join(root, ".env.local.example"),
    path.join(root, "scripts", "validate-sanity-env.mjs"),
    ...(await listSourceFiles(path.join(root, "src"))),
  ].filter((filePath) => filePath !== fileURLToPath(import.meta.url));
  const forbiddenRuntimePatterns = [
    new RegExp("@" + "clerk/", "i"),
    new RegExp("CLERK" + "_"),
    new RegExp("clerk" + "Middleware", "i"),
    new RegExp("Clerk" + "Provider"),
  ];

  for (const filePath of runtimeFiles) {
    const source = await readFile(filePath, "utf8");

    for (const pattern of forbiddenRuntimePatterns) {
      assert.doesNotMatch(source, pattern, path.relative(root, filePath));
    }
  }
});

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return listSourceFiles(filePath);
      }

      return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [filePath] : [];
    }),
  );

  return files.flat();
}
