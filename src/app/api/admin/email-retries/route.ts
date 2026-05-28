import { getEmailRetrySecret } from "@/lib/env/private-checkout";
import {
  retryTransactionalEmail,
  type TransactionalEmailRetryFlow,
} from "@/lib/transactional-email-retry";

export const runtime = "nodejs";

interface EmailRetryRequestBody {
  flow: TransactionalEmailRetryFlow;
  orderId: string;
}

interface EmailRetryDependencies {
  getRetrySecret: () => string | null;
  logError: typeof console.error;
  retryTransactionalEmail: typeof retryTransactionalEmail;
}

const defaultDependencies: EmailRetryDependencies = {
  getRetrySecret: getTransactionalEmailRetrySecret,
  logError: console.error,
  retryTransactionalEmail,
};

export const POST = createEmailRetryPostHandler(defaultDependencies);

export function createEmailRetryPostHandler(
  dependencies: EmailRetryDependencies,
): (req: Request) => Promise<Response> {
  return async function emailRetryPostHandler(req: Request): Promise<Response> {
    const retrySecret = dependencies.getRetrySecret();

    if (retrySecret === null) {
      return new Response(null, { status: 404 });
    }

    if (!isAuthorizedRetryRequest(req, retrySecret)) {
      return new Response(null, { status: 401 });
    }

    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return invalidRetryRequestResponse();
    }

    const parsed = parseEmailRetryRequestBody(body);

    if (parsed === null) {
      return invalidRetryRequestResponse();
    }

    try {
      const result = await dependencies.retryTransactionalEmail({
        ...parsed,
        origin: new URL(req.url).origin,
      });

      return Response.json(result);
    } catch (error) {
      dependencies.logError("[email-retry] Manual transactional email retry failed", {
        error: error instanceof Error ? error.message : "Unknown email retry error",
        flow: parsed.flow,
        orderId: parsed.orderId,
      });

      return Response.json(
        { error: "Transactional email retry failed" },
        { status: 503 },
      );
    }
  };
}

function parseEmailRetryRequestBody(body: unknown): EmailRetryRequestBody | null {
  if (!isRecord(body) || typeof body.orderId !== "string" || !isRetryFlow(body.flow)) {
    return null;
  }

  const orderId = body.orderId.trim();

  if (orderId.length === 0) {
    return null;
  }

  return {
    flow: body.flow,
    orderId,
  };
}

function isAuthorizedRetryRequest(req: Request, retrySecret: string): boolean {
  const authorization = req.headers.get("authorization");

  if (authorization === `Bearer ${retrySecret}`) {
    return true;
  }

  return req.headers.get("x-lash-email-retry-secret") === retrySecret;
}

function invalidRetryRequestResponse(): Response {
  return Response.json(
    { error: "Invalid email retry request" },
    { status: 400 },
  );
}

function getTransactionalEmailRetrySecret(): string | null {
  try {
    return getEmailRetrySecret();
  } catch {
    return null;
  }
}

function isRetryFlow(value: unknown): value is TransactionalEmailRetryFlow {
  return value === "booking" || value === "product" || value === "training";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
