import assert from "node:assert/strict";
import test from "node:test";
import { coursePrice, customerSignInHref, formatPosition, safeLearningUrl, validCourseSlug } from "./presentation";

test("learning content links and image/caption URLs reject executable, credentialed and insecure schemes", () => {
  for (const value of ["javascript:alert(1)", "data:text/html,hi", "http://media.invalid/vtt", "https://user:secret@media.invalid/vtt", "//evil.invalid", " /x", "/\\evil.invalid", "https://media.invalid/\nprivate"]) assert.equal(safeLearningUrl(value, true), undefined);
  assert.equal(safeLearningUrl("https://media.invalid/captions.vtt"), "https://media.invalid/captions.vtt");
  assert.equal(safeLearningUrl("/courses/lash-care", true), "/courses/lash-care");
  assert.equal(safeLearningUrl("/courses/lash-care"), undefined);
});
test("course links, price and resume labels preserve canonical paths and CAD access semantics", () => {
  assert.equal(validCourseSlug("lash-care"), true); assert.equal(validCourseSlug("../account"), false);
  assert.equal(formatPosition(125.8), "2:05"); assert.equal(formatPosition(Number.NaN), "0:00");
  assert.equal(coursePrice({ accessMode: "free", priceCents: 0, currency: "CAD" }), "Free");
  assert.notEqual(coursePrice({ accessMode: "paid", priceCents: 0, currency: "CAD" }), "Free");
  assert.equal(customerSignInHref("/academy?course=lash-care"), "/sign-in?callbackUrl=%2Facademy%3Fcourse%3Dlash-care");
});
