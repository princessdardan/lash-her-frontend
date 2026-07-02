import "server-only";

const SQUARE_VERSION = "2026-05-20";
const SQUARE_BASE_URLS = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
} as const;

export interface SquareCreateCardRequest {
  idempotency_key: string;
  source_id: string;
  verification_token?: string;
  card: {
    customer_id: string;
    cardholder_name?: string;
    reference_id?: string;
    billing_address?: {
      postal_code?: string;
      country?: string;
    };
  };
}

export interface SquareCard {
  id: string;
  card_brand: string;
  last_4: string;
  exp_month: number;
  exp_year: number;
}

export interface SquareCreateCardResponse {
  card: SquareCard;
}

export interface SquareCardsClientEnv {
  accessToken: string;
  environment: "sandbox" | "production";
}

export interface SquareCardsClient {
  createCard(
    request: SquareCreateCardRequest,
  ): Promise<SquareCreateCardResponse>;
}

export function createSquareCardsClient(
  env: SquareCardsClientEnv,
): SquareCardsClient {
  return {
    async createCard(request) {
      return postSquare<SquareCreateCardRequest, SquareCreateCardResponse>(
        env,
        "/v2/cards",
        request,
        isSquareCreateCardResponse,
      );
    },
  };
}

export async function createSquareCard(
  env: SquareCardsClientEnv,
  request: SquareCreateCardRequest,
): Promise<SquareCreateCardResponse> {
  return createSquareCardsClient(env).createCard(request);
}

async function postSquare<TRequest, TResponse>(
  env: SquareCardsClientEnv,
  path: string,
  request: TRequest,
  validateResponse: (value: unknown) => value is TResponse,
): Promise<TResponse> {
  let response: Response;

  try {
    response = await fetch(`${SQUARE_BASE_URLS[env.environment]}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.accessToken}`,
        "content-type": "application/json",
        "square-version": SQUARE_VERSION,
      },
      body: JSON.stringify(request),
      cache: "no-store",
    });
  } catch {
    throw new Error("Square API request failed before receiving a response");
  }

  if (!response.ok) {
    throw new Error(`Square API request failed with status ${response.status}`);
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    throw new Error("Square API response was malformed");
  }

  if (!validateResponse(body)) {
    throw new Error("Square API response was malformed");
  }

  return body;
}

function isSquareCreateCardResponse(
  value: unknown,
): value is SquareCreateCardResponse {
  if (!isRecord(value) || !isRecord(value.card)) {
    return false;
  }

  const card = value.card;

  return (
    typeof card.id === "string" &&
    typeof card.card_brand === "string" &&
    typeof card.last_4 === "string" &&
    typeof card.exp_month === "number" &&
    typeof card.exp_year === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
