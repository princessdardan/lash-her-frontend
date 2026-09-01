import "server-only";

import { recordInternalUnsubscribe } from "@/lib/marketing-contact/marketing-contact-store";
import {
  buildMarketingUnsubscribeUrlFromToken,
  verifyMarketingUnsubscribeToken,
  type VerifiedMarketingUnsubscribeToken,
} from "@/lib/marketing-contact/unsubscribe-token";

export const runtime = "nodejs";

const UNSUBSCRIBE_REASON = "contact_popup_email_unsubscribe";
const UNSUBSCRIBE_METADATA = {
  mechanism: "signed_unsubscribe_url",
  source: "contact_popup_customer_email",
} as const;

const HTML_SECURITY_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy":
    "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

const BLANK_SECURITY_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

interface MarketingUnsubscribeHandlerDependencies {
  buildUrlFromToken: (token: string) => string;
  logError: (message: string) => void;
  recordInternalUnsubscribe: typeof recordInternalUnsubscribe;
  verifyToken: (token: string) => VerifiedMarketingUnsubscribeToken | null;
}

const defaultDependencies: MarketingUnsubscribeHandlerDependencies = {
  buildUrlFromToken: buildMarketingUnsubscribeUrlFromToken,
  logError: console.error,
  recordInternalUnsubscribe,
  verifyToken: verifyMarketingUnsubscribeToken,
};

export const GET = createMarketingUnsubscribeGetHandler(defaultDependencies);
export const POST = createMarketingUnsubscribePostHandler(defaultDependencies);

export function createMarketingUnsubscribeGetHandler(
  dependencies: MarketingUnsubscribeHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async function getMarketingUnsubscribe(
    request: Request,
  ): Promise<Response> {
    const token = readToken(request);
    if (token === null) {
      return invalidTokenHtmlResponse();
    }

    let verified: VerifiedMarketingUnsubscribeToken | null;
    try {
      verified = dependencies.verifyToken(token);
    } catch {
      dependencies.logError(
        "[marketing-unsubscribe] Token verification configuration failed",
      );
      return unavailableHtmlResponse();
    }

    if (verified === null) {
      return invalidTokenHtmlResponse();
    }

    let action: string;
    try {
      action = dependencies.buildUrlFromToken(token);
    } catch {
      dependencies.logError(
        "[marketing-unsubscribe] Canonical site URL configuration failed",
      );
      return unavailableHtmlResponse();
    }

    return new Response(renderConfirmationHtml(action), {
      headers: HTML_SECURITY_HEADERS,
      status: 200,
    });
  };
}

export function createMarketingUnsubscribePostHandler(
  dependencies: MarketingUnsubscribeHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async function postMarketingUnsubscribe(
    request: Request,
  ): Promise<Response> {
    const token = readToken(request);
    if (token === null) {
      return blankResponse(400);
    }

    let verified: VerifiedMarketingUnsubscribeToken | null;
    try {
      verified = dependencies.verifyToken(token);
    } catch {
      dependencies.logError(
        "[marketing-unsubscribe] Token verification configuration failed",
      );
      return blankResponse(503);
    }

    if (verified === null) {
      return blankResponse(400);
    }

    try {
      await dependencies.recordInternalUnsubscribe({
        email: verified.email,
        metadata: {
          ...UNSUBSCRIBE_METADATA,
          tokenVersion: verified.tokenVersion,
        },
        reason: UNSUBSCRIBE_REASON,
      });
    } catch {
      // Never include the exception, token, or email: persistence-layer errors
      // may contain values from the attempted write.
      dependencies.logError(
        "[marketing-unsubscribe] Unsubscribe persistence failed",
      );
      return blankResponse(503);
    }

    // RFC 8058 one-click requests expect a successful empty response. The
    // durable store keeps the contact idempotently unsubscribed on replays.
    return blankResponse(200);
  };
}

function readToken(request: Request): string | null {
  let value: string | null;
  try {
    value = new URL(request.url).searchParams.get("token");
  } catch {
    return null;
  }

  return value && value.length > 0 ? value : null;
}

function renderConfirmationHtml(action: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unsubscribe | Lash Her by Nataliea</title>
</head>
<body>
  <main>
    <h1>Unsubscribe from Lash Her emails</h1>
    <p>Confirm that you no longer want to receive marketing emails from Lash Her by Nataliea.</p>
    <form method="post" action="${escapeHtmlAttribute(action)}">
      <button type="submit">Unsubscribe</button>
    </form>
  </main>
</body>
</html>`;
}

function invalidTokenHtmlResponse(): Response {
  return new Response(
    renderMessageHtml(
      "Invalid unsubscribe link",
      "This unsubscribe link is invalid.",
    ),
    { headers: HTML_SECURITY_HEADERS, status: 400 },
  );
}

function unavailableHtmlResponse(): Response {
  return new Response(
    renderMessageHtml(
      "Unsubscribe unavailable",
      "The unsubscribe service is temporarily unavailable.",
    ),
    { headers: HTML_SECURITY_HEADERS, status: 503 },
  );
}

function renderMessageHtml(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | Lash Her by Nataliea</title>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
  </main>
</body>
</html>`;
}

function blankResponse(status: number): Response {
  return new Response(null, { headers: BLANK_SECURITY_HEADERS, status });
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
