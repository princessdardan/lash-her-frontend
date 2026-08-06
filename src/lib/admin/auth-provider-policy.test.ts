import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getToken } from "next-auth/jwt";

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

  assert.equal(packageJson.dependencies?.["next-auth"], "5.0.0-beta.32");
  assert.deepEqual(
    Object.keys(dependencies).filter((name) =>
      name.toLowerCase().includes("clerk"),
    ),
    [],
  );

  const lockfile = await readFile(path.join(root, "package-lock.json"), "utf8");
  const lockfileJson = JSON.parse(lockfile) as {
    packages?: Record<string, { version?: string }>;
  };

  assert.equal(
    lockfileJson.packages?.["node_modules/@auth/core"]?.version,
    "0.41.3",
    "next-auth must resolve the Auth.js core release that fixes GHSA-x445-f3h2-j279",
  );
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

test("Auth.js rejects malformed bearer encoding without throwing", async () => {
  const token = await getToken({
    req: new Request("https://lash.test/admin", {
      headers: { authorization: "Bearer %E0%A4%A" },
    }),
    secret: "unit-test-auth-secret",
  });

  assert.equal(token, null);
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
