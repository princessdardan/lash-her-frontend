import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("admin search uses an accessible dialog and combobox contract", async () => {
  const source = await readFile(
    new URL("./admin-search.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /@radix-ui\/react-dialog/);
  assert.match(source, /<Dialog\.Title/);
  assert.match(source, /<Dialog\.Description/);
  assert.match(source, /role="combobox"/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /role="option"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /aria-activedescendant=/);
});

test("admin search exposes its shortcut and keyboard result navigation", async () => {
  const source = await readFile(
    new URL("./admin-search.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /aria-keyshortcuts="Control\+K Meta\+K"/);
  assert.match(source, /event\.key === "ArrowDown"/);
  assert.match(source, /event\.key === "ArrowUp"/);
  assert.match(source, /event\.key === "Enter"/);
  assert.match(source, /scrollIntoView\(\{ block: "nearest" \}\)/);
});
