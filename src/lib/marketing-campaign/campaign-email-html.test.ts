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
