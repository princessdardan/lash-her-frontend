import "server-only";

import {
  getTrainingAfterpaySquareInvoiceEnv,
} from "@/lib/env/private-checkout";

const SQUARE_VERSION = "2026-05-20";
const SQUARE_BASE_URLS = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
} as const;

export interface SquareInvoiceClientEnv {
  accessToken: string;
  environment: "sandbox" | "production";
  enabled?: boolean;
}

export interface SquareInvoiceMoney {
  amount: number;
  currency: "CAD";
}

export interface SquareInvoiceLineItem {
  name: string;
  quantity: string;
  base_price_money: SquareInvoiceMoney;
  note?: string;
}

export interface SquareInvoicePaymentRequestInput {
  dueDate?: string;
  idempotencyKey: string;
}

export interface SquareDraftInvoice {
  id: string;
  version: number;
}

export interface SquarePublishedInvoice extends SquareDraftInvoice {
  publicUrl: string;
}

export interface SquareInvoiceDetails {
  id: string;
  version?: number;
  public_url?: string;
  status?: string;
  [key: string]: unknown;
}

export interface SquareInvoiceClient {
  createCustomer(email: string, givenName: string, familyName: string): Promise<string>;
  createOrder(
    locationId: string,
    lineItems: SquareInvoiceLineItem[],
    referenceId: string,
  ): Promise<string>;
  createInvoice(
    orderId: string,
    customerId: string,
    paymentRequest: SquareInvoicePaymentRequestInput,
  ): Promise<SquareDraftInvoice>;
  publishInvoice(
    invoiceId: string,
    version: number,
    idempotencyKey: string,
  ): Promise<SquarePublishedInvoice>;
  getInvoice(invoiceId: string): Promise<SquareInvoiceDetails>;
}

interface SquareCreateCustomerRequest {
  email_address: string;
  given_name: string;
  family_name: string;
}

interface SquareCreateCustomerResponse {
  customer: {
    id: string;
  };
}

interface SquareCreateOrderRequest {
  idempotency_key: string;
  order: {
    location_id: string;
    state: "OPEN";
    line_items: SquareInvoiceLineItem[];
    reference_id: string;
  };
}

interface SquareCreateOrderResponse {
  order: {
    id: string;
  };
}

interface SquareCreateInvoiceRequest {
  idempotency_key: string;
  invoice: {
    order_id: string;
    primary_recipient: {
      customer_id: string;
    };
    delivery_method: "SHARE_MANUALLY";
    payment_requests: [
      {
        request_type: "BALANCE";
        due_date?: string;
        accepted_payment_methods: {
          buy_now_pay_later: true;
        };
      },
    ];
  };
}

interface SquareInvoiceResponse {
  invoice: SquareInvoiceDetails;
}

interface SquareDraftInvoiceResponse {
  invoice: SquareDraftInvoice;
}

interface SquarePublishedInvoiceResponse {
  invoice: {
    id: string;
    version: number;
    public_url: string;
  };
}

interface SquarePublishInvoiceRequest {
  idempotency_key: string;
  version: number;
}

type SquareOperation = "default" | "createInvoice" | "publishInvoice";

export class SquareInvoiceBNPLUnavailableError extends Error {
  constructor() {
    super("Square invoice buy now, pay later is unavailable");
    this.name = "SquareInvoiceBNPLUnavailableError";
  }
}

export class SquareInvoicePublishError extends Error {
  constructor(readonly status: number) {
    super(`Square invoice publish failed with status ${status}`);
    this.name = "SquareInvoicePublishError";
  }
}

export class SquareInvoiceVersionConflictError extends Error {
  constructor(readonly status: number) {
    super(`Square invoice version conflict with status ${status}`);
    this.name = "SquareInvoiceVersionConflictError";
  }
}

export function createSquareInvoiceClient(env: SquareInvoiceClientEnv): SquareInvoiceClient {
  return {
    async createCustomer(email, givenName, familyName) {
      assertInvoiceClientEnabled(env);

      const response = await postSquare<SquareCreateCustomerRequest, SquareCreateCustomerResponse>(
        env,
        "/v2/customers",
        {
          email_address: email,
          given_name: givenName,
          family_name: familyName,
        },
        isSquareCreateCustomerResponse,
      );

      return response.customer.id;
    },

    async createOrder(locationId, lineItems, referenceId) {
      assertInvoiceClientEnabled(env);
      assertCadLineItems(lineItems);

      const response = await postSquare<SquareCreateOrderRequest, SquareCreateOrderResponse>(
        env,
        "/v2/orders",
        {
          idempotency_key: `${referenceId}-order`,
          order: {
            location_id: locationId,
            state: "OPEN",
            line_items: lineItems,
            reference_id: referenceId,
          },
        },
        isSquareCreateOrderResponse,
      );

      return response.order.id;
    },

    async createInvoice(orderId, customerId, paymentRequest) {
      assertInvoiceClientEnabled(env);

      const response = await postSquare<SquareCreateInvoiceRequest, SquareDraftInvoiceResponse>(
        env,
        "/v2/invoices",
        {
          idempotency_key: paymentRequest.idempotencyKey,
          invoice: {
            order_id: orderId,
            primary_recipient: {
              customer_id: customerId,
            },
            delivery_method: "SHARE_MANUALLY",
            payment_requests: [
              {
                request_type: "BALANCE",
                ...(paymentRequest.dueDate === undefined ? {} : { due_date: paymentRequest.dueDate }),
                accepted_payment_methods: {
                  buy_now_pay_later: true,
                },
              },
            ],
          },
        },
        isSquareDraftInvoiceResponse,
        "createInvoice",
      );

      return response.invoice;
    },

    async publishInvoice(invoiceId, version, idempotencyKey) {
      assertInvoiceClientEnabled(env);

      const response = await postSquare<SquarePublishInvoiceRequest, SquarePublishedInvoiceResponse>(
        env,
        `/v2/invoices/${encodeURIComponent(invoiceId)}/publish`,
        {
          version,
          idempotency_key: idempotencyKey,
        },
        isSquarePublishedInvoiceResponse,
        "publishInvoice",
      );

      return {
        id: response.invoice.id,
        publicUrl: response.invoice.public_url,
        version: response.invoice.version,
      };
    },

    async getInvoice(invoiceId) {
      assertInvoiceClientEnabled(env);

      const response = await getSquare<SquareInvoiceResponse>(
        env,
        `/v2/invoices/${encodeURIComponent(invoiceId)}`,
        isSquareInvoiceResponse,
      );

      return response.invoice;
    },
  };
}

export function createTrainingAfterpaySquareInvoiceClient(): SquareInvoiceClient {
  const env = getTrainingAfterpaySquareInvoiceEnv();

  if (env === null) {
    throw new Error("Square invoice checkout is not enabled");
  }

  return createSquareInvoiceClient({
    accessToken: env.accessToken,
    environment: env.environment,
    enabled: true,
  });
}

async function postSquare<TRequest, TResponse>(
  env: SquareInvoiceClientEnv,
  path: string,
  request: TRequest,
  validateResponse: (value: unknown) => value is TResponse,
  operation: SquareOperation = "default",
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

  return handleSquareResponse(response, validateResponse, operation);
}

async function getSquare<TResponse>(
  env: SquareInvoiceClientEnv,
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

  return handleSquareResponse(response, validateResponse, "default");
}

async function handleSquareResponse<TResponse>(
  response: Response,
  validateResponse: (value: unknown) => value is TResponse,
  operation: SquareOperation,
): Promise<TResponse> {
  const body = await readSquareJson(response);

  if (!response.ok) {
    throw createSquareError(response.status, body, operation);
  }

  if (!validateResponse(body)) {
    throw new Error("Square API response was malformed");
  }

  return body;
}

async function readSquareJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function createSquareError(status: number, body: unknown, operation: SquareOperation): Error {
  if (operation === "createInvoice" && isBnplUnavailable(body)) {
    return new SquareInvoiceBNPLUnavailableError();
  }

  if (operation === "publishInvoice" && isVersionConflict(status, body)) {
    return new SquareInvoiceVersionConflictError(status);
  }

  if (operation === "publishInvoice") {
    return new SquareInvoicePublishError(status);
  }

  return new Error(`Square API request failed with status ${status}`);
}

function isBnplUnavailable(body: unknown): boolean {
  const errorText = getSquareErrorText(body);

  return errorText.includes("buy_now_pay_later") ||
    errorText.includes("buy now, pay later") ||
    errorText.includes("bnpl") ||
    errorText.includes("afterpay");
}

function isVersionConflict(status: number, body: unknown): boolean {
  if (status === 409) {
    return true;
  }

  const errorText = getSquareErrorText(body);

  return errorText.includes("version_mismatch") ||
    errorText.includes("version conflict") ||
    errorText.includes("version mismatch");
}

function getSquareErrorText(body: unknown): string {
  if (!isRecord(body)) {
    return "";
  }

  const errors = body.errors;

  if (!Array.isArray(errors)) {
    return "";
  }

  return errors
    .filter(isRecord)
    .flatMap((error) => [error.code, error.category, error.detail])
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function assertInvoiceClientEnabled(env: SquareInvoiceClientEnv): void {
  if (env.enabled === false) {
    throw new Error("Square invoice checkout is not enabled");
  }
}

function assertCadLineItems(lineItems: SquareInvoiceLineItem[]): void {
  for (const lineItem of lineItems) {
    if (lineItem.base_price_money.currency !== "CAD") {
      throw new Error("Square invoice orders must use CAD currency");
    }
  }
}

function isSquareCreateCustomerResponse(value: unknown): value is SquareCreateCustomerResponse {
  return isRecord(value) &&
    isRecord(value.customer) &&
    typeof value.customer.id === "string";
}

function isSquareCreateOrderResponse(value: unknown): value is SquareCreateOrderResponse {
  return isRecord(value) &&
    isRecord(value.order) &&
    typeof value.order.id === "string";
}

function isSquareDraftInvoiceResponse(value: unknown): value is SquareDraftInvoiceResponse {
  return isRecord(value) && isDraftInvoice(value.invoice);
}

function isSquarePublishedInvoiceResponse(value: unknown): value is SquarePublishedInvoiceResponse {
  return isRecord(value) &&
    isRecord(value.invoice) &&
    typeof value.invoice.id === "string" &&
    typeof value.invoice.version === "number" &&
    typeof value.invoice.public_url === "string";
}

function isSquareInvoiceResponse(value: unknown): value is SquareInvoiceResponse {
  return isRecord(value) &&
    isRecord(value.invoice) &&
    typeof value.invoice.id === "string";
}

function isDraftInvoice(value: unknown): value is SquareDraftInvoice {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.version === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
