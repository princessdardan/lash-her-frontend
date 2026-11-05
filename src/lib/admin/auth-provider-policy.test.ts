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
  assert.equal(packageJson.dependencies?.["@auth/core"], "file:vendor/security/lash-her-auth-core-0.41.3-lash-her.1.tgz");
  assert.deepEqual(
    Object.keys(dependencies).filter((name) =>
      name.toLowerCase().includes("clerk"),
    ),
    [],
  );

  const lockfile = await readFile(path.join(root, "package-lock.json"), "utf8");
  const lockfileJson = JSON.parse(lockfile) as {
    packages?: Record<string, { name?: string; version?: string; resolved?: string }>;
  };

  const core = lockfileJson.packages?.["node_modules/@auth/core"];
  assert.deepEqual({ name: core?.name, version: core?.version, resolved: core?.resolved }, {
    name: "@lash-her/auth-core", version: "0.41.3-lash-her.1", resolved: "file:vendor/security/lash-her-auth-core-0.41.3-lash-her.1.tgz",
  });
  const inventory = JSON.parse(await readFile(path.join(root, "vendor/security/forks.json"), "utf8")) as {
    forks: Array<{ dependency: string; name: string; version: string; upstream: { name: string; version: string } }>;
  };
  const fork = inventory.forks.find(entry => entry.dependency === "@auth/core");
  assert.equal(fork?.name, core?.name); assert.equal(fork?.version, core?.version);
  assert.deepEqual(fork?.upstream && { name: fork.upstream.name, version: fork.upstream.version },
    { name: "@auth/core", version: "0.41.3" }, "the reviewed fork must retain the security-fixed 0.41.3 upstream baseline");
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
