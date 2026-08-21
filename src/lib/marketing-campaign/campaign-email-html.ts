import "server-only";

import sanitizeHtml from "sanitize-html";

import {
  escapeHtml,
  getEmailProfileImageHtml,
} from "@/lib/transactional-email";

// Resend replaces this merge tag with each recipient's hosted unsubscribe URL
// when a broadcast is sent. Including it keeps every campaign CAN-SPAM/CASL
// compliant and drives the unsubscribe -> webhook -> DB suppression loop.
export const RESEND_UNSUBSCRIBE_MERGE_TAG = "{{{RESEND_UNSUBSCRIBE_URL}}}";

const BRAND_NAME = "Lash Her by Nataliea";

// Email-safe allowlist for owner-composed rich text. Deliberately narrow: no
// scripts, iframes, forms, event handlers, or class hooks — just the formatting
// a marketing email needs. Applied server-side so it cannot be bypassed by the
// client editor.
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "a",
    "ul",
    "ol",
    "li",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "span",
    "div",
    "img",
    "hr",
  ],
  allowedAttributes: {
    a: ["href", "target", "rel"],
    img: ["src", "alt", "width", "height", "style"],
    p: ["style"],
    div: ["style"],
    span: ["style"],
    h1: ["style"],
    h2: ["style"],
    h3: ["style"],
    h4: ["style"],
    li: ["style"],
    blockquote: ["style"],
  },
  allowedStyles: {
    "*": {
      color: [/^#(0x)?[0-9a-f]+$/i, /^rgb\(/, /^[a-z-]+$/i],
      "text-align": [/^left$/, /^right$/, /^center$/, /^justify$/],
      "font-weight": [/^bold$/, /^normal$/, /^\d{3}$/],
      "font-style": [/^italic$/, /^normal$/],
      "text-decoration": [/^underline$/, /^line-through$/, /^none$/],
    },
  },
  // Only safe, external-ish link schemes. No javascript:, data:, etc.
  allowedSchemes: ["https", "http", "mailto", "tel"],
  allowedSchemesAppliedToAttributes: ["href", "src"],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", {
      target: "_blank",
      rel: "noopener noreferrer",
    }),
  },
};

/**
 * Sanitizes owner-composed rich-text HTML down to an email-safe subset. Returns
 * the cleaned HTML; throws nothing (empty input yields an empty string).
 */
export function sanitizeCampaignBodyHtml(rawHtml: string): string {
  return sanitizeHtml(rawHtml, SANITIZE_OPTIONS).trim();
}

export interface WrapCampaignEmailHtmlInput {
  bodyHtml: string;
  previewText?: string;
  subject: string;
}

/**
 * Wraps sanitized campaign body HTML in the Lash Her brand email shell, matching
 * the transactional emails, with a hidden preheader and a compliant unsubscribe
 * footer (Resend fills in the per-recipient URL at send time).
 */
export function wrapCampaignEmailHtml(
  input: WrapCampaignEmailHtmlInput,
): string {
  // Defense-in-depth: re-sanitize at send time so any body that reached storage
  // through a future path is still cleaned before it goes out. Idempotent for
  // already-sanitized content.
  const safeBody = sanitizeCampaignBodyHtml(input.bodyHtml);
  const preheader = input.previewText?.trim();
  const preheaderBlock = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(
        preheader,
      )}</div>`
    : "";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(input.subject)}</title>
</head>
<body style="margin: 0; padding: 0; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background-color: #F5F1F5;">
  ${preheaderBlock}
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; background-color: #FFFFFF; border-radius: 8px; box-shadow: 0 12px 32px rgba(28, 19, 24, 0.08);">

          <!-- Header -->
          <tr>
            <td style="background: #1C1318; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
              ${getEmailProfileImageHtml()}
              <h1 style="margin: 0; color: #FFFFFF; font-size: 24px; font-weight: 600; font-family: 'Bebas Neue', 'Arial Narrow', Impact, sans-serif; letter-spacing: 0.04em; text-transform: uppercase;">
                ${escapeHtml(BRAND_NAME)}
              </h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px; color: #3D0B16; font-size: 15px; line-height: 1.6;">
              ${safeBody}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #F5F1F5; padding: 20px 30px; border-radius: 0 0 8px 8px; border-top: 1px solid #E8E2E9;">
              <p style="margin: 0; color: #746A72; font-size: 12px; text-align: center;">
                ${escapeHtml(BRAND_NAME)}
              </p>
              <p style="margin: 10px 0 0 0; color: #746A72; font-size: 11px; text-align: center;">
                You are receiving this because you opted in to updates from Lash Her by Nataliea.
                <a href="${RESEND_UNSUBSCRIBE_MERGE_TAG}" style="color: #663976; text-decoration: underline;">Unsubscribe</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}
