import "server-only";

const SQUARE_VERSION = "2026-05-20";
const SQUARE_BASE_URLS = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
} as const;

export interface SquareCreateCustomerRequest {
  idempotency_key: string;
  email_address?: string;
  given_name?: string;
  family_name?: string;
  phone_number?: string;
  reference_id?: string;
}

export interface SquareCustomer {
  id: string;
}

export interface SquareCreateCustomerResponse {
  customer: SquareCustomer;
}

export interface SquareCustomersClientEnv {
  accessToken: string;
  environment: "sandbox" | "production";
}

export interface SquareCustomersClient {
  createCustomer(
    request: SquareCreateCustomerRequest,
  ): Promise<SquareCreateCustomerResponse>;
}

export function createSquareCustomersClient(
  env: SquareCustomersClientEnv,
): SquareCustomersClient {
  return {
    async createCustomer(request) {
      return postSquare<
        SquareCreateCustomerRequest,
        SquareCreateCustomerResponse
      >(env, "/v2/customers", request, isSquareCreateCustomerResponse);
    },
  };
}

export async function createSquareCustomer(
  env: SquareCustomersClientEnv,
  request: SquareCreateCustomerRequest,
): Promise<SquareCreateCustomerResponse> {
  return createSquareCustomersClient(env).createCustomer(request);
}

async function postSquare<TRequest, TResponse>(
  env: SquareCustomersClientEnv,
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

function isSquareCreateCustomerResponse(
  value: unknown,
): value is SquareCreateCustomerResponse {
  return (
    isRecord(value) &&
    isRecord(value.customer) &&
    typeof value.customer.id === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
