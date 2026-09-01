import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./loaders.ts", import.meta.url), "utf8");

test("public global settings do not project the signup offer", () => {
  const publicGlobalLoader = functionSource("getGlobalData");

  assert.doesNotMatch(publicGlobalLoader, /signupOffer|signupPromotion/);
});

test("signup offer configuration uses fresh published Sanity reads", () => {
  const offerLoader = functionSource("getContactPopupSignupOfferConfig");

  assert.match(offerLoader, /useCdn: false/);
  assert.match(offerLoader, /perspective: "published"/);
  assert.equal(offerLoader.match(/cache: "no-store"/g)?.length, 1);
  assert.equal(offerLoader.match(/publishedClient\.fetch/g)?.length, 1);
  assert.match(
    offerLoader,
    /_id == "globalSettings" && _type == "globalSettings"/,
  );
  assert.match(offerLoader, /contactPopup\.signupPromotion->/);
  assert.match(offerLoader, /_rev/);
  assert.match(offerLoader, /_type == "promotionCode" && code == \^\.code/);
});

function functionSource(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const end = source.indexOf("\nasync function ", start + 1);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}
