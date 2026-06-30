import "server-only";

const SQUARE_VERSION = "2026-05-20";
const SQUARE_BASE_URLS = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
} as const;

export interface SquareMoney {
  amount: number;
  currency: string;
}

export interface SquareCreateOrderRequest {
  idempotency_key: string;
  order: {
    location_id: string;
    reference_id?: string;
    source?: { name?: string };
    metadata?: Record<string, string>;
    line_items: Array<{
      name: string;
      quantity: string;
      base_price_money: SquareMoney;
    }>;
  };
}

export interface SquareOrder {
  id: string;
  location_id: string;
}

export interface SquareCreateOrderResponse {
  order: SquareOrder;
}

export interface SquareInvoicePaymentRequest {
  request_method?: "EMAIL";
  request_type?: "BALANCE";
  due_date: string;
  automatic_payment_source: "CARD_ON_FILE";
  card_id: string;
}

export interface SquareCreateInvoiceRequest {
  idempotency_key: string;
  invoice: {
    order_id: string;
    location_id: string;
    primary_recipient: {
      customer_id: string;
    };
    accepted_payment_methods: { card: boolean };
    payment_requests: SquareInvoicePaymentRequest[];
    delivery_method: "EMAIL";
  };
}

export interface SquareInvoice {
  id: string;
  status: string;
  order_id: string;
  version: number;
}

export interface SquareCreateInvoiceResponse {
  invoice: SquareInvoice;
}

export interface SquarePublishInvoiceRequest {
  idempotency_key: string;
  version: number;
}

export interface SquarePublishInvoiceResponse {
  invoice: SquareInvoice & { payment_id?: string };
}

export interface SquareGetInvoiceResponse {
  invoice: SquareInvoice & { payment_id?: string };
}

export interface SquareInvoicesClientEnv {
  accessToken: string;
  environment: "sandbox" | "production";
}

export interface SquareInvoicesClient {
  createOrder(
    request: SquareCreateOrderRequest,
  ): Promise<SquareCreateOrderResponse>;
  createInvoice(
    request: SquareCreateInvoiceRequest,
  ): Promise<SquareCreateInvoiceResponse>;
  publishInvoice(
    invoiceId: string,
    request: SquarePublishInvoiceRequest,
  ): Promise<SquarePublishInvoiceResponse>;
  deleteInvoice(invoiceId: string, version?: number): Promise<void>;
  getInvoice(invoiceId: string): Promise<SquareGetInvoiceResponse>;
}

export function createSquareInvoicesClient(
  env: SquareInvoicesClientEnv,
): SquareInvoicesClient {
  return {
    async createOrder(request) {
      return postSquare<SquareCreateOrderRequest, SquareCreateOrderResponse>(
        env,
        "/v2/orders",
        request,
        isSquareCreateOrderResponse,
      );
    },
    async createInvoice(request) {
      return postSquare<
        SquareCreateInvoiceRequest,
        SquareCreateInvoiceResponse
      >(env, "/v2/invoices", request, isSquareCreateInvoiceResponse);
    },
    async publishInvoice(invoiceId, request) {
      return postSquare<
        SquarePublishInvoiceRequest,
        SquarePublishInvoiceResponse
      >(
        env,
        `/v2/invoices/${encodeURIComponent(invoiceId)}/publish`,
        request,
        isSquarePublishInvoiceResponse,
      );
    },
    async deleteInvoice(invoiceId, version) {
      return deleteSquare(
        env,
        `/v2/invoices/${encodeURIComponent(invoiceId)}`,
        version,
      );
    },
    async getInvoice(invoiceId) {
      return getSquare<SquareGetInvoiceResponse>(
        env,
        `/v2/invoices/${encodeURIComponent(invoiceId)}`,
        isSquareGetInvoiceResponse,
      );
    },
  };
}

export async function createSquareOrder(
  env: SquareInvoicesClientEnv,
  request: SquareCreateOrderRequest,
): Promise<SquareCreateOrderResponse> {
  return createSquareInvoicesClient(env).createOrder(request);
}

export async function createSquareInvoice(
  env: SquareInvoicesClientEnv,
  request: SquareCreateInvoiceRequest,
): Promise<SquareCreateInvoiceResponse> {
  return createSquareInvoicesClient(env).createInvoice(request);
}

export async function publishSquareInvoice(
  env: SquareInvoicesClientEnv,
  invoiceId: string,
  request: SquarePublishInvoiceRequest,
): Promise<SquarePublishInvoiceResponse> {
  return createSquareInvoicesClient(env).publishInvoice(invoiceId, request);
}

export async function deleteSquareInvoice(
  env: SquareInvoicesClientEnv,
  invoiceId: string,
  version?: number,
): Promise<void> {
  return createSquareInvoicesClient(env).deleteInvoice(invoiceId, version);
}

async function deleteSquare(
  env: SquareInvoicesClientEnv,
  path: string,
  version?: number,
): Promise<void> {
  const url = new URL(`${SQUARE_BASE_URLS[env.environment]}${path}`);
  if (version !== undefined) {
    url.searchParams.set("version", String(version));
  }

  let response: Response;

  try {
    response = await fetch(url.toString(), {
      method: "DELETE",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.accessToken}`,
        "square-version": SQUARE_VERSION,
      },
      cache: "no-store",
    });
  } catch {
    throw new Error("Square API request failed before receiving a response");
  }

  if (!response.ok) {
    throw new Error(`Square API request failed with status ${response.status}`);
  }
}

async function postSquare<TRequest, TResponse>(
  env: SquareInvoicesClientEnv,
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

async function getSquare<TResponse>(
  env: SquareInvoicesClientEnv,
  path: string,
  validateResponse: (value: unknown) => value is TResponse,
): Promise<TResponse> {
  let response: Response;

  try {
    response = await fetch(`${SQUARE_BASE_URLS[env.environment]}${path}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.accessToken}`,
        "square-version": SQUARE_VERSION,
      },
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

function isSquareCreateOrderResponse(
  value: unknown,
): value is SquareCreateOrderResponse {
  return (
    isRecord(value) &&
    isRecord(value.order) &&
    typeof value.order.id === "string" &&
    typeof value.order.location_id === "string"
  );
}

function isSquareCreateInvoiceResponse(
  value: unknown,
): value is SquareCreateInvoiceResponse {
  return (
    isRecord(value) &&
    isRecord(value.invoice) &&
    typeof value.invoice.id === "string" &&
    typeof value.invoice.status === "string" &&
    typeof value.invoice.order_id === "string" &&
    typeof value.invoice.version === "number"
  );
}

function isSquarePublishInvoiceResponse(
  value: unknown,
): value is SquarePublishInvoiceResponse {
  return (
    isRecord(value) &&
    isRecord(value.invoice) &&
    typeof value.invoice.id === "string" &&
    typeof value.invoice.status === "string" &&
    typeof value.invoice.version === "number"
  );
}

function isSquareGetInvoiceResponse(
  value: unknown,
): value is SquareGetInvoiceResponse {
  return (
    isRecord(value) &&
    isRecord(value.invoice) &&
    typeof value.invoice.id === "string" &&
    typeof value.invoice.status === "string" &&
    typeof value.invoice.order_id === "string" &&
    typeof value.invoice.version === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
