import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { frontendWriterInventory } from "./frontend-writer-inventory.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "frontend-writers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["src/app/api/callback", "src/app/actions", "scripts", "ops/platform"]) mkdirSync(join(root, dir), { recursive: true });
  const save = (path, text) => writeFileSync(join(root, path), text);
  save("ops/platform/vercel-config.mjs", 'export const jobs = [{path:"/api/cron/worker", schedule:"* * * * *"}];');
  return { root, save };
}

test("inventory includes GET callbacks, re-exports, server actions, deferred work, scripts and native definitions", (t) => {
  const { root, save } = fixture(t);
  save("src/app/api/callback/route.ts", 'export { callback as GET } from "./handler"; export const POST = async () => new Response();');
  save("src/app/actions/actions.ts", '"use server"; export async function mutate() {} export { other as renamed } from "./other";');
  save("src/app/page.tsx", 'import {after as defer} from "next/server"; export default async function Page(){ async function nested(){"use server";} defer(()=>{}); return null; }');
  save("scripts/worker.ts", 'import {Pool as Database} from "pg"; const pool = new Database();');
  save("scripts/ignored.test.ts", 'new Client();');
  const inventory = frontendWriterInventory(root);
  assert.deepEqual(inventory.routes[0].methods, ["GET", "POST"]);
  assert.deepEqual(inventory.actionModules[0].exports, ["mutate", "renamed"]);
  assert.equal(inventory.inlineActions.length, 1); assert.equal(inventory.deferredSites[0].callee, "defer");
  assert.equal(inventory.databaseConstructors[0].file, "scripts/worker.ts");
  assert.equal(inventory.version, 2);
  assert.deepEqual(inventory.renderEntries.map(({file, exports, runtime}) => ({file, exports, runtime})),
    [{file:"src/app/page.tsx", exports:["default"], runtime:"server"}]);
  assert.equal(inventory.manualEntries[0].file, "scripts/worker.ts");
  assert.deepEqual(inventory.manualEntries[0].exports, []);
  assert.deepEqual(inventory.schedules, [{ path: "/api/cron/worker", schedule: "* * * * *" }]);
  assert.equal(inventory.deploymentInventoryVerified, false); assert.equal(inventory.writerFenceVerified, false); assert.equal(inventory.drainVerified, false);
});

test("render generators, client pages and scripts without database constructors remain review surfaces", t => {
  const { root, save } = fixture(t);
  save("src/app/layout.tsx", 'export async function generateMetadata() {} export default function Layout() {}');
  save("src/app/page.tsx", '\"use client\"; export default function Page() {}');
  save("scripts/provider-only.mjs", 'await fetch(\"https://owned.invalid\", {method: \"POST\"});');
  const inventory = frontendWriterInventory(root);
  assert.deepEqual(inventory.renderEntries[0].exports, ["default", "generateMetadata"]);
  assert.equal(inventory.renderEntries[1].runtime, "client");
  assert.equal(inventory.manualEntries[0].file, "scripts/provider-only.mjs");
  assert.equal(inventory.databaseConstructors.length, 0);
});

test("source changes change the inventory identity, including implementation-only changes", (t) => {
  const { root, save } = fixture(t);
  save("src/helper.ts", "export const value = 1;"); const before = frontendWriterInventory(root);
  save("src/helper.ts", "export const value = 2;");
  assert.notEqual(frontendWriterInventory(root).sourceManifestSha256, before.sourceManifestSha256);
});

test("NextAuth-style destructured HTTP methods are included", (t) => {
  const { root, save } = fixture(t);
  save("src/app/api/callback/route.ts", 'export const { GET, POST } = handlers;');
  assert.deepEqual(frontendWriterInventory(root).routes[0].methods, ["GET", "POST"]);
});

test("default server actions retain their public export name for every declaration form", (t) => {
  const { root, save } = fixture(t);
  for (const source of [
    'export default async function mutate() {}',
    'export default async function() {}',
    'export default async () => {};',
    'async function mutate() {} export default mutate;',
    'export { mutate as default } from "./other";',
  ]) {
    save("src/app/actions/actions.ts", '"use server"; ' + source);
    assert.deepEqual(frontendWriterInventory(root).actionModules[0].exports, ["default"], source);
  }
});

test("ambiguous export-star, invalid syntax and symlinks refuse instead of returning a complete-looking inventory", (t) => {
  const { root, save } = fixture(t);
  save("src/app/api/callback/route.ts", 'export * from "./handler";');
  assert.throws(() => frontendWriterInventory(root), /INVENTORY_REFUSED/u);
  save("src/app/api/callback/route.ts", "export function GET(");
  assert.throws(() => frontendWriterInventory(root), /INVENTORY_REFUSED/u);
  save("src/app/api/callback/route.ts", "export function GET() {}");
  symlinkSync(join(root, "scripts"), join(root, "src/alias"));
  assert.throws(() => frontendWriterInventory(root), /INVENTORY_REFUSED/u);
});
