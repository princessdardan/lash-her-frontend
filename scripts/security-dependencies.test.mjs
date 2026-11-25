import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const braces = require("braces");
const loadYamlFile = require("load-yaml-file");

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lash-security-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("every installed security fork matches its reviewed source and archive", () => {
  execFileSync(process.execPath, ["scripts/verify-security-forks.mjs"], {
    cwd: root,
  });
});

test("Auth.js observes a verification provider failure throughout token hashing", () => {
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { sendToken } from "./node_modules/@auth/core/lib/actions/signin/send-token.js";

    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const hashStarted = Promise.withResolvers();
    const finishHash = Promise.withResolvers();
    crypto.subtle.digest = async (...args) => {
      hashStarted.resolve();
      await finishHash.promise;
      return digest(...args);
    };

    const failure = new Error("fixture persistence failed");
    const unhandled = [];
    process.on("unhandledRejection", error => unhandled.push(error));
    process.on("rejectionHandled", () => {});
    const url = new URL("https://frontend.example.invalid/");
    const request = { body: { email: "fixture@example.invalid" }, method: "POST", url };
    let adapterCalls = 0;
    const options = {
      provider: {
        id: "fixture",
        type: "email",
        generateVerificationToken: () => "fixture-token",
        async sendVerificationRequest() { throw failure; },
      },
      callbacks: { signIn: () => true },
      adapter: {
        getUserByEmail: () => null,
        async createVerificationToken() { adapterCalls++; },
      },
      url,
      basePath: "/auth",
      secret: "fixture-only",
    };

    const rejected = assert.rejects(sendToken(request, options), error => error === failure);
    await hashStarted.promise;
    await new Promise(resolve => setImmediate(resolve));
    finishHash.resolve();
    await rejected;
    assert.equal(adapterCalls, 1);
    assert.deepEqual(unhandled, []);

    options.provider.sendVerificationRequest = () => { throw failure; };
    await assert.rejects(sendToken(request, options), error => error === failure);
    assert.equal(adapterCalls, 1, "a synchronously refused provider must not start another write");
  `], { cwd: root, timeout: 5_000 });
});

test("braces retains expansion, ranges, escaping, and malformed-pattern behavior", () => {
  assert.deepEqual(braces.expand("src/{app,lib}/{a,b}.ts"), [
    "src/app/a.ts",
    "src/app/b.ts",
    "src/lib/a.ts",
    "src/lib/b.ts",
  ]);
  assert.deepEqual(braces.expand("{01..03}"), ["01", "02", "03"]);
  assert.deepEqual(braces.expand("{a..c}"), ["a", "b", "c"]);
  assert.deepEqual(braces.expand(String.raw`\{a,b\}`), ["{a,b}"]);
  assert.deepEqual(braces.expand("{a,{b,c}}", { nodupes: true }), [
    "a",
    "b",
    "c",
  ]);
  assert.equal(braces.compile("a/{b,c}/d"), "a/(b|c)/d");
  assert.equal(braces.stringify(braces.parse("a/{b,c}/d")), "a/{b,c}/d");
  assert.deepEqual(braces.expand("a/{b,c"), ["a/{b,c"]);
  assert.throws(() => braces.expand("{1..1001}"), /range limit/);
  assert.throws(() => braces.parse("a".repeat(65537)), /max characters/);
});

test("braces accepts the nesting boundary and rejects excessive strings and ASTs", () => {
  const nested = (depth, open = "{", close = "}") =>
    open.repeat(depth) + "a,b" + close.repeat(depth);
  for (const method of ["parse", "compile", "expand", "stringify"]) {
    assert.doesNotThrow(() => braces[method](nested(128)));
    for (const pattern of [
      nested(129),
      nested(129, "(", ")"),
      "{".repeat(129) + "a",
      "({".repeat(65) + "a" + "})".repeat(65),
    ]) {
      assert.throws(
        () =>
          braces[method](pattern, { maxDepth: Infinity, rangeLimit: false }),
        { name: "SyntaxError", code: "ERR_BRACES_MAX_DEPTH" },
      );
    }
  }
  let ast = { type: "brace", nodes: [] };
  for (let i = 0; i < 128; i++) ast = { type: "brace", nodes: [ast] };
  for (const method of ["compile", "expand", "stringify"]) {
    assert.throws(() => braces[method](ast), {
      name: "SyntaxError",
      code: "ERR_BRACES_MAX_DEPTH",
    });
  }
  const cycle = { type: "brace", nodes: [] };
  cycle.nodes.push(cycle);
  assert.throws(() => braces.compile(cycle), { code: "ERR_BRACES_CYCLIC_AST" });
});

test("reported deeply nested inputs fail in a bounded subprocess without stack exhaustion", () => {
  execFileSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require('node:assert/strict');
    const braces = require('braces');
    for (const open of ['{', '(']) {
      const input = open.repeat(4000) + 'a,b' + (open === '{' ? '}' : ')').repeat(4000);
      for (const method of ['parse', 'compile', 'expand', 'stringify']) {
        assert.throws(() => braces[method](input), {name: 'SyntaxError', code: 'ERR_BRACES_MAX_DEPTH'});
      }
    }
  `,
    ],
    { cwd: root, timeout: 5000 },
  );
});

test("micromatch and fast-glob preserve real file selection", async (t) => {
  const directory = await fixture(t);
  await mkdir(path.join(directory, "nested"));
  for (const file of ["a.ts", "b.tsx", "ignore.js", "nested/c.ts"])
    await writeFile(path.join(directory, file), "");
  const micromatch = require("micromatch");
  assert.deepEqual(micromatch(["a.ts", "b.tsx", "ignore.js"], "*.{ts,tsx}"), [
    "a.ts",
    "b.tsx",
  ]);
  const glob = require("fast-glob");
  assert.deepEqual(
    glob.sync(["**/*.{ts,tsx}", "!**/c.ts"], { cwd: directory }).sort(),
    ["a.ts", "b.tsx"],
  );
});

test("chokidar retains brace glob watching", { timeout: 10000 }, async (t) => {
  const directory = await fixture(t);
  const requireCodegen = createRequire(import.meta.resolve("@sanity/codegen"));
  const watcher = requireCodegen("chokidar").watch(
    path.join(directory, "*.{ts,tsx}"),
    { ignoreInitial: true, usePolling: true, interval: 25 },
  );
  t.after(() => watcher.close());
  await once(watcher, "ready");
  const added = once(watcher, "add");
  await writeFile(path.join(directory, "created.tsx"), "");
  const [file] = await added;
  assert.equal(path.basename(file), "created.tsx");
});

test("YAML loader preserves both APIs, BOM handling, errors, and safe parsing", async (t) => {
  const directory = await fixture(t);
  const file = path.join(directory, "fixture.yaml");
  await writeFile(
    file,
    "\ufeffpackageManager: pnpm@9.0.0\nstoreDir: /tmp/store\n",
  );
  assert.deepEqual(await loadYamlFile(file), {
    packageManager: "pnpm@9.0.0",
    storeDir: "/tmp/store",
  });
  assert.deepEqual(loadYamlFile.sync(file), await loadYamlFile(file));
  const missing = path.join(directory, "missing.yaml");
  await assert.rejects(loadYamlFile(missing), { code: "ENOENT" });
  assert.throws(() => loadYamlFile.sync(missing), { code: "ENOENT" });
  for (const invalid of [
    "broken: [",
    "!!js/function 'function () { return 1 }'",
    "!!js/regexp /evil/",
  ]) {
    await writeFile(file, invalid);
    await assert.rejects(loadYamlFile(file), { name: "YAMLException" });
    assert.throws(() => loadYamlFile.sync(file), { name: "YAMLException" });
  }
});

test("Sanity CLI detects pnpm and npm from their user agents", async () => {
  const { getBinCommand } = await import("@sanity/cli-core/package-manager");
  assert.equal(
    getBinCommand({ userAgent: "pnpm/9.0.0 npm/?" }),
    "pnpm exec sanity",
  );
  assert.equal(getBinCommand({ userAgent: "npm/11.17.0" }), "npx sanity");
});

test("Vercel framework detection reads YAML and TOML with patched parsers", async (t) => {
  const requireSanityCli = createRequire(import.meta.resolve("@sanity/cli"));
  const { readConfigFile } = requireSanityCli(
    "@vercel/frameworks/dist/read-config-file.js",
  );
  const directory = await fixture(t);
  const yaml = path.join(directory, "config.yaml");
  const toml = path.join(directory, "config.toml");
  await writeFile(yaml, 'build:\n  output: "public"\n');
  await writeFile(toml, '[build]\noutput = "public"\n');
  const yamlConfig = await readConfigFile([
    path.join(directory, "missing.yaml"),
    yaml,
  ]);
  assert.deepEqual(yamlConfig, { build: { output: "public" } });
  assert.equal((await readConfigFile(toml)).build.output, "public");
  await writeFile(yaml, "build: [");
  await assert.rejects(readConfigFile(yaml), { name: "YAMLException" });
});

test("Tailwind typography generates selectors using the patched parser", async () => {
  const result = await require("postcss")([
    require("@tailwindcss/postcss")(),
  ]).process(
    '@import "tailwindcss"; @plugin "@tailwindcss/typography"; @source inline("prose prose-headings:underline");',
    { from: path.join(root, "security-typography.css") },
  );
  assert.match(result.css, /\.prose\s*\{/);
  assert.match(result.css, /:where\(h1\)/);
  assert.match(result.css, /:not\(:where\(\[class~="not-prose"\]/);
  assert.match(result.css, /text-decoration-line: underline/);
});

test("both reported markdown denial-of-service inputs complete within a bounded subprocess", () => {
  execFileSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require('node:assert/strict');
    const MarkdownIt = require('markdown-it');
    const html = new MarkdownIt({html: true});
    assert.equal(typeof html.render('text ' + '<!--'.repeat(100000)), 'string');
    const md = new MarkdownIt();
    assert.equal(typeof md.render('[a]: /url "' + '\\na'.repeat(200000)), 'string');
  `,
    ],
    { cwd: root, timeout: 8000, maxBuffer: 1024 * 1024 },
  );
});

test("selected fixed dependencies are installed at the reviewed versions", async () => {
  const lock = JSON.parse(
    await readFile(path.join(root, "package-lock.json"), "utf8"),
  );
  const versions = {
    "markdown-it": ["15.0.3"],
    i18next: ["26.7.2"],
    "js-yaml": ["4.3.2"],
    "smol-toml": ["1.9.1"],
    vite: ["8.3.8"],
    postcss: ["8.5.31"],
    "source-map-js": ["1.2.2"],
    "postcss-selector-parser": ["7.1.7"],
    undici: ["6.29.1", "7.30.1", "8.13.1"],
    zod: ["4.6.6"],
  };
  for (const [name, reviewedVersions] of Object.entries(versions)) {
    const entries = Object.entries(lock.packages).filter(
      ([location]) =>
        location.endsWith(`/node_modules/${name}`) ||
        location === `node_modules/${name}`,
    );
    assert(entries.length, `${name} installed`);
    for (const [, entry] of entries) {
      assert(
        reviewedVersions.includes(entry.version),
        `${name}@${entry.version} reviewed`,
      );
    }
  }
});

test("Sanity codegen retains config defaults and validation", async (t) => {
  const { readConfig } = await import("@sanity/codegen");
  const directory = await fixture(t);
  const configPath = path.join(directory, "sanity-typegen.json");
  const defaults = await readConfig(configPath);
  assert.equal(defaults.schema, "./schema.json");
  assert.equal(defaults.generates, "./sanity.types.ts");
  assert.equal(defaults.formatGeneratedCode, true);
  await writeFile(
    configPath,
    JSON.stringify({
      path: ["src/**/*.ts"],
      generates: "generated.ts",
      overloadClientMethods: false,
    }),
  );
  const configured = await readConfig(configPath);
  assert.deepEqual(configured.path, ["src/**/*.ts"]);
  assert.equal(configured.generates, "generated.ts");
  assert.equal(configured.overloadClientMethods, false);
  await writeFile(configPath, JSON.stringify({ path: 123 }));
  await assert.rejects(
    readConfig(configPath),
    (error) => error.name === "ValiError" && error.issues.length > 0,
  );
});

test("patched Zod rejects oversized constrained collections before parsing their elements", () => {
  execFileSync(
    process.execPath,
    [
      "--max-old-space-size=96",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { z } from 'zod';
    let parsed = 0;
    const element = z.preprocess(value => { parsed++; return value; }, z.string());
    const schema = z.array(element).max(8);
    assert.deepEqual(schema.parse(['valid']), ['valid']);
    parsed = 0;
    const result = schema.safeParse(new Array(500_000).fill(null));
    assert.equal(result.success, false);
    assert.equal(result.error.issues[0].code, 'too_big');
    assert.equal(parsed, 0);
  `,
    ],
    { cwd: root, timeout: 8000, maxBuffer: 1024 * 1024 },
  );
});

test("flat selector parsing and hostile source-map offsets stay bounded", () => {
  execFileSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require('node:assert/strict');
    const {createRequire} = require('node:module');
    const typographyRequire = createRequire(require.resolve('@tailwindcss/typography/package.json'));
    const selector = typographyRequire('postcss-selector-parser');
    const input = '.a'.repeat(100000);
    assert.equal(selector().processSync(input), input);
    const {SourceMapConsumer} = require('source-map-js');
    assert.throws(() => new SourceMapConsumer({version: 3, sections: [{
      offset: {line: 1e12, column: 0},
      map: {version: 3, sources: ['a.js'], names: [], mappings: 'AAAA'},
    }]}), /Section offset line/);
  `,
    ],
    { cwd: root, timeout: 8000, maxBuffer: 1024 * 1024 },
  );
});
