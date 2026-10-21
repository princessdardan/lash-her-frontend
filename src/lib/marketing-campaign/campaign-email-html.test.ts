import assert from "node:assert/strict";
import test from "node:test";

import {
  RESEND_UNSUBSCRIBE_MERGE_TAG,
  sanitizeCampaignBodyHtml,
  wrapCampaignEmailHtml,
} from "./campaign-email-html";

test("sanitize strips scripts, event handlers, and javascript: links", () => {
  const dirty =
    "<p>Hi <strong>there</strong></p>" +
    '<script>alert("xss")</script>' +
    '<p onclick="steal()">click</p>' +
    '<a href="javascript:alert(1)">bad</a>';

  const clean = sanitizeCampaignBodyHtml(dirty);

  assert.ok(!clean.includes("<script"), "script tag removed");
  assert.ok(!clean.includes("alert"), "script contents removed");
  assert.ok(!/onclick/i.test(clean), "event handler removed");
  assert.ok(!/javascript:/i.test(clean), "javascript: scheme removed");
  assert.ok(clean.includes("<strong>there</strong>"), "formatting preserved");
});

test("sanitize keeps allowed formatting and hardens links", () => {
  const clean = sanitizeCampaignBodyHtml(
    "<ul><li>One</li><li>Two</li></ul>" +
      '<a href="https://lashher.com">Visit</a>',
  );

  assert.ok(clean.includes("<ul>"), "lists preserved");
  assert.ok(clean.includes("<li>One</li>"), "list items preserved");
  assert.ok(clean.includes('href="https://lashher.com"'), "safe link kept");
  assert.ok(clean.includes('target="_blank"'), "target added");
  assert.ok(clean.includes('rel="noopener noreferrer"'), "rel added");
});

test("sanitize returns empty string for empty input", () => {
  assert.equal(sanitizeCampaignBodyHtml(""), "");
});

test("sanitize discards malformed noscript regions and their hidden images", () => {
  for (const payload of [
    '<div><noscript></div><img src="https://evil.test/beacon.gif"></noscript>',
    '<p>Hi</p><![CDATA[ x > <noscript>]]><img src="https://evil.test/beacon.gif"></noscript>',
  ]) {
    const clean = sanitizeCampaignBodyHtml(payload);
    assert.doesNotMatch(clean, /beacon|noscript|<img/i);
  }
});

test("HTML normalization rejects excessive element and template nesting safely", () => {
  for (const tag of ["div", "template"]) {
    const input = `<${tag}>`.repeat(5000) + "body" + `</${tag}>`.repeat(5000);
    assert.equal(sanitizeCampaignBodyHtml(input), "");
  }
  assert.match(
    sanitizeCampaignBodyHtml("<div>".repeat(32) + "body" + "</div>".repeat(32)),
    /body/,
  );
});

test("sanitize rejects namespaced SVG, refresh metadata, and encoded unsafe URLs", () => {
  const clean = sanitizeCampaignBodyHtml(
    '<svg><a href="#safe"><svg:animate attributeName="href" values="#safe;javascript:alert(1)" /></a></svg>' +
      '<meta http-equiv="refresh" content="0;url=data:text/html,evil">' +
      '<a href="jav&#x61;script:alert(1)">encoded</a>' +
      '<img src="&#0000106;avascript:alert(1)" onerror="alert(1)">',
  );
  assert.doesNotMatch(clean, /javascript:|data:|onerror|<svg|animate|<meta/i);
});

test("sanitization remains idempotent and preserves email styles and placeholders", () => {
  const raw =
    '<h2 style="text-align:center">Title</h2><p><strong>Bold</strong> <em>italic</em></p>' +
    '<a href="https://lashher.com">Visit</a>' +
    RESEND_UNSUBSCRIBE_MERGE_TAG;
  const clean = sanitizeCampaignBodyHtml(raw);
  assert.equal(sanitizeCampaignBodyHtml(clean), clean);
  assert.match(clean, /text-align:center/);
  assert.match(clean, /<strong>Bold<\/strong>/);
  assert.match(clean, /<em>italic<\/em>/);
  assert.ok(clean.includes(RESEND_UNSUBSCRIBE_MERGE_TAG));
});

test("wrap includes the escaped subject, body, and unsubscribe merge tag", () => {
  const html = wrapCampaignEmailHtml({
    subject: 'Spring "sale" <now>',
    bodyHtml: "<p>Book your next set</p>",
  });

  assert.ok(html.includes("<p>Book your next set</p>"), "body embedded");
  assert.ok(
    html.includes(RESEND_UNSUBSCRIBE_MERGE_TAG),
    "unsubscribe merge tag present for compliance",
  );
  assert.ok(
    html.includes("Spring &quot;sale&quot; &lt;now&gt;"),
    "subject escaped in title",
  );
  assert.ok(!html.includes("<now>"), "raw subject not injected");
});

test("send-time rendering refuses empty or unusable historical content", () => {
  for (const bodyHtml of [
    "",
    "<script>alert(1)</script>",
    "<div>".repeat(5000) + "body" + "</div>".repeat(5000),
  ]) {
    assert.throws(
      () => wrapCampaignEmailHtml({ subject: "Historical draft", bodyHtml }),
      /Email content is empty or cannot be sanitized safely/,
    );
  }
});

test("wrap renders a hidden preheader only when preview text is provided", () => {
  const withPreview = wrapCampaignEmailHtml({
    subject: "Hello",
    previewText: "A short teaser",
    bodyHtml: "<p>Body</p>",
  });
  const withoutPreview = wrapCampaignEmailHtml({
    subject: "Hello",
    bodyHtml: "<p>Body</p>",
  });

  assert.ok(withPreview.includes("A short teaser"), "preheader text present");
  assert.ok(
    withPreview.includes("display:none"),
    "preheader is visually hidden",
  );
  assert.ok(
    !withoutPreview.includes("display:none"),
    "no hidden preheader without preview text",
  );
});
