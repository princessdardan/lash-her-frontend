import { randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { parsePromotionCodeInput } from "@/lib/commerce/discounts";
import { createPaymentMockStore, type PaymentMockStore } from "@/lib/payment-mocks/in-memory-store";
import {
  createMockSquareInvoice,
  createSquareInvoicePublishedWebhookPayload,
} from "@/lib/payment-mocks/square-invoices";
import {
  assertPaymentMockAllowed,
  resolvePaymentGatewayMode,
  resolvePaymentMockScenario,
} from "@/lib/payment-mocks/runtime-controls";
import { validateTrainingCheckoutRequest } from "@/lib/training-checkout";
import type { TPromotionCode, TTrainingProgram } from "@/types";
import type { PaymentMockScenario } from "@/lib/payment-mocks/scenarios";
import type {
  SquareDraftInvoice,
  SquareInvoiceClient,
  SquareInvoiceLineItem,
  SquarePublishedInvoice,
} from "@/lib/commerce/square-invoice-client";

type SquareInvoiceScenario = Extract<PaymentMockScenario, `square_invoice_${string}`>;

interface TrainingSquareInvoiceResponseBody {
  orderId: string;
  publicUrl: string;
}

interface TrainingSquareInvoiceErrorBody {
  error: string;
}

interface TrainingSquareInvoicePostHandlerDependencies {
  createCheckoutToken?: () => string;
  createCorrelationId?: () => string;
  createPendingSquareInvoiceOrder: (input: TrainingSquareInvoicePendingOrderInput) => Promise<TrainingSquareInvoicePendingOrder>;
  createSecretToken?: () => string;
  getPromotionCode: (code: string) => Promise<TPromotionCode | null>;
  getTrainingProgramBySlug: (slug: string) => Promise<TTrainingProgram | null>;
  isEnabled?: () => boolean;
  locationId: string;
  recordSquareInvoicePublication: (orderId: string, invoiceId: string, publicUrl: string, version: number) => Promise<void>;
  squareInvoiceClient: SquareInvoiceClient;
}

interface TrainingSquareInvoicePendingOrderInput {
  amountCents: number;
  checkoutToken: string;
  correlationId: string;
  customerEmail: string;
  customerName: string;
  programSlug: string;
  secretToken: string;
  squareCustomerId: string;
  squareInvoiceId: string;
  squareInvoicePublicUrl?: string;
  squareInvoiceVersion?: number;
  squareOrderId: string;
}

interface TrainingSquareInvoicePendingOrder {
  _id: string;
  orderId?: string;
}

interface TrainingSquareInvoiceRuntimeEnv {
  accessToken: string;
  environment: "sandbox" | "production";
  locationId: string;
}

interface TrainingSquareInvoiceEnvModule {
  getPaymentMockRuntimeEnvironment: () => Parameters<typeof resolvePaymentGatewayMode>[0];
  getTrainingAfterpaySquareInvoiceEnv: () => TrainingSquareInvoiceRuntimeEnv | null;
  isTrainingAfterpaySquareInvoiceEnabled: () => boolean;
}

const trainingSquareInvoicePaymentMockStore = createPaymentMockStore();
const fallbackMockRequest = new Request("http://localhost:3000/api/training-checkout/square-invoice/mock-runtime");

export function createTrainingSquareInvoicePostHandler({
  createCheckoutToken = () => `sq-invoice-checkout-${randomUUID()}`,
  createCorrelationId = () => `sq-invoice-${randomUUID()}`,
  createPendingSquareInvoiceOrder,
  createSecretToken = () => `sq-invoice-secret-${randomUUID()}`,
  getPromotionCode,
  getTrainingProgramBySlug,
  isEnabled = defaultTrainingAfterpaySquareInvoiceEnabled,
  locationId,
  recordSquareInvoicePublication,
  squareInvoiceClient,
}: TrainingSquareInvoicePostHandlerDependencies): (req: NextRequest | Request) => Promise<Response> {
  return async function trainingSquareInvoicePostHandler(req: NextRequest | Request): Promise<Response> {
    if (!isEnabled()) {
      return unavailableTrainingSquareInvoiceResponse();
    }

    let body: unknown;

    try {
      body = await req.json();
    } catch {
      return invalidTrainingSquareInvoiceRequest();
    }

    const programSlug = parseProgramSlug(body);

    if (programSlug === null) {
      return invalidTrainingSquareInvoiceRequest();
    }

    try {
      const requestedPromotionCode = parsePromotionCodeInput(isRecord(body) ? body.promotionCode ?? body.discountCode : undefined);
      if (requestedPromotionCode === null) {
        return NextResponse.json<TrainingSquareInvoiceErrorBody>(
          { error: "Invalid promotion code" },
          { status: 400 },
        );
      }

      const [program, promotionCode] = await Promise.all([
        getTrainingProgramBySlug(programSlug),
        requestedPromotionCode ? getPromotionCode(requestedPromotionCode) : Promise.resolve(null),
      ]);
      const validation = validateTrainingCheckoutRequest(program, body, promotionCode);

      if (!validation.ok) {
        return invalidTrainingSquareInvoiceRequest();
      }

      const { quote } = validation;
      const amountCents = toCents(quote.total);
      const correlationId = createCorrelationId();
      const customerName = splitCustomerName(quote.customerName);
      const customerId = await squareInvoiceClient.createCustomer(
        quote.customerEmail,
        customerName.givenName,
        customerName.familyName,
      );
      const squareOrderId = await squareInvoiceClient.createOrder(
        locationId,
        [toSquareInvoiceLineItem({ amountCents, programTitle: quote.programTitle })],
        correlationId,
      );
      const draftInvoice = await squareInvoiceClient.createInvoice(
        squareOrderId,
        customerId,
        { idempotencyKey: `${correlationId}-invoice` },
      );
      const pendingOrder = await createPendingSquareInvoiceOrder({
        amountCents,
        checkoutToken: createCheckoutToken(),
        correlationId,
        customerEmail: quote.customerEmail,
        customerName: quote.customerName,
        programSlug: quote.programSlug,
        secretToken: createSecretToken(),
        squareCustomerId: customerId,
        squareInvoiceId: draftInvoice.id,
        squareInvoiceVersion: draftInvoice.version,
        squareOrderId,
      });
      const publishedInvoice = await squareInvoiceClient.publishInvoice(
        draftInvoice.id,
        draftInvoice.version,
        `${correlationId}-publish`,
      );
      const publicOrderId = pendingOrder.orderId ?? pendingOrder._id;

      await recordSquareInvoicePublication(
        publicOrderId,
        publishedInvoice.id,
        publishedInvoice.publicUrl,
        publishedInvoice.version,
      );

      return NextResponse.json<TrainingSquareInvoiceResponseBody>({
        publicUrl: publishedInvoice.publicUrl,
        orderId: publicOrderId,
      });
    } catch (error) {
      if (isSquareInvoiceBnplUnavailableError(error)) {
        return NextResponse.json<TrainingSquareInvoiceErrorBody>(
          { error: "Buy now, pay later is unavailable for this training checkout" },
          { status: 422 },
        );
      }

      if (isSquareInvoicePublishError(error)) {
        console.error("[training-square-invoice] Unable to publish invoice", {
          error: error instanceof Error ? error.message : "Unknown Square invoice publish error",
        });

        return NextResponse.json<TrainingSquareInvoiceErrorBody>(
          { error: "Unable to publish Square invoice" },
          { status: 502 },
        );
      }

      console.error("[training-square-invoice] Unable to initialize checkout", {
        error: error instanceof Error ? error.message : "Unknown training Square invoice error",
      });

      return NextResponse.json<TrainingSquareInvoiceErrorBody>(
        { error: "Unable to start training Square invoice checkout" },
        { status: 400 },
      );
    }
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const envModule = await import("@/lib/env/private-checkout");

  if (!envModule.isTrainingAfterpaySquareInvoiceEnabled()) {
    return unavailableTrainingSquareInvoiceResponse();
  }

  const [
    { loaders },
    orderStore,
  ] = await Promise.all([
    import("@/data/loaders"),
    import("@/lib/commerce/order-store"),
  ]);
  const runtimeEnv = getTrainingAfterpaySquareInvoiceRuntimeEnv(envModule);

  if (runtimeEnv === null) {
    return unavailableTrainingSquareInvoiceResponse();
  }

  return createTrainingSquareInvoicePostHandler({
    createPendingSquareInvoiceOrder: orderStore.createPendingSquareInvoiceOrder,
    getPromotionCode: loaders.getPromotionCode,
    getTrainingProgramBySlug: (slug) => loaders.getTrainingProgramBySlug(slug, { mode: "published", stega: false }),
    isEnabled: envModule.isTrainingAfterpaySquareInvoiceEnabled,
    locationId: runtimeEnv.locationId,
    recordSquareInvoicePublication: orderStore.recordSquareInvoicePublication,
    squareInvoiceClient: await createTrainingAfterpaySquareInvoiceClientForRequest({
      envModule,
      env: runtimeEnv,
      request: req,
    }),
  })(req);
}

function getTrainingAfterpaySquareInvoiceRuntimeEnv(envModule: TrainingSquareInvoiceEnvModule): TrainingSquareInvoiceRuntimeEnv | null {
  if (!envModule.isTrainingAfterpaySquareInvoiceEnabled()) {
    return null;
  }

  const runtimeEnvironment = envModule.getPaymentMockRuntimeEnvironment();

  if (resolvePaymentGatewayMode(runtimeEnvironment) !== "mock") {
    return envModule.getTrainingAfterpaySquareInvoiceEnv();
  }

  return {
    accessToken: process.env.SQUARE_ACCESS_TOKEN?.trim() || "mock-square-access-token",
    environment: process.env.SQUARE_ENVIRONMENT === "production" ? "production" : "sandbox",
    locationId: process.env.SQUARE_LOCATION_ID?.trim() || "mock-square-location",
  };
}

async function createTrainingAfterpaySquareInvoiceClientForRequest(input: {
  env: TrainingSquareInvoiceRuntimeEnv;
  envModule: TrainingSquareInvoiceEnvModule;
  request?: Request;
}): Promise<SquareInvoiceClient> {
  const runtimeEnvironment = input.envModule.getPaymentMockRuntimeEnvironment();
  const request = input.request ?? fallbackMockRequest;

  assertPaymentMockAllowed({ env: runtimeEnvironment, request });

  if (resolvePaymentGatewayMode(runtimeEnvironment) !== "mock") {
    const { createSquareInvoiceClient } = await import("@/lib/commerce/square-invoice-client");

    return createSquareInvoiceClient({
      accessToken: input.env.accessToken,
      environment: input.env.environment,
      enabled: true,
    });
  }

  return createMockTrainingAfterpaySquareInvoiceClient({
    request,
    scenario: toSquareInvoiceScenario(resolvePaymentMockScenario({
      env: runtimeEnvironment,
      now: new Date(),
      request,
    })),
    store: trainingSquareInvoicePaymentMockStore,
  });
}

function createMockTrainingAfterpaySquareInvoiceClient(input: {
  request: Request;
  scenario: SquareInvoiceScenario;
  store: PaymentMockStore;
}): SquareInvoiceClient {
  return {
    async createCustomer(email) {
      return `mock-square-invoice-customer-${toStableId(email)}`;
    },

    async createOrder(_locationId, _lineItems, referenceId) {
      return `mock-square-invoice-order-${toStableId(referenceId)}`;
    },

    async createInvoice(orderId, customerId, paymentRequest) {
      if (input.scenario === "square_invoice_afterpay_unavailable") {
        throw createNamedSquareInvoiceError("SquareInvoiceBNPLUnavailableError", "Square invoice buy now, pay later is unavailable");
      }

      const amountCents = 0;
      const response = createMockSquareInvoice({
        amountCents,
        customerId,
        idempotencyKey: paymentRequest.idempotencyKey,
        orderId,
        request: input.request,
        scenario: input.scenario,
        store: input.store,
      });

      return {
        id: response.invoice.id,
        version: response.invoice.version,
      } satisfies SquareDraftInvoice;
    },

    async publishInvoice(invoiceId, version) {
      if (input.scenario === "square_invoice_publish_failed") {
        throw createNamedSquareInvoiceError("SquareInvoicePublishError", "Square invoice publish failed with status 400");
      }

      const payload = createSquareInvoicePublishedWebhookPayload({
        invoiceId,
        store: input.store,
      });
      const invoice = payload.data.object.invoice;

      return {
        id: invoice.id,
        publicUrl: invoice.public_url,
        version: Math.max(invoice.version, version + 1),
      } satisfies SquarePublishedInvoice;
    },

    async getOrder(orderId) {
      return {
        id: orderId,
        reference_id: getReferenceIdFromMockOrderId(orderId),
      };
    },

    async getInvoice(invoiceId) {
      const invoice = input.store.getSquareInvoiceRecord(invoiceId);

      if (invoice === null) {
        return { id: invoiceId };
      }

      return {
        id: invoice.invoiceId,
        public_url: invoice.publicUrl,
        status: invoice.status,
        version: invoice.version,
      };
    },
  };
}

function defaultTrainingAfterpaySquareInvoiceEnabled(): boolean {
  return process.env.TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED === "true";
}

function createNamedSquareInvoiceError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function isSquareInvoiceBnplUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.name === "SquareInvoiceBNPLUnavailableError";
}

function isSquareInvoicePublishError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "SquareInvoicePublishError" ||
    error.name === "SquareInvoiceVersionConflictError"
  );
}

function toSquareInvoiceScenario(scenario: string): SquareInvoiceScenario {
  switch (scenario) {
    case "square_invoice_afterpay_unavailable":
    case "square_invoice_duplicate_paid":
    case "square_invoice_finalization_retry":
    case "square_invoice_paid_mismatch":
    case "square_invoice_publish_failed":
    case "square_invoice_success":
    case "square_invoice_unpaid":
      return scenario;
    default:
      return "square_invoice_success";
  }
}

function toSquareInvoiceLineItem(input: { amountCents: number; programTitle: string }): SquareInvoiceLineItem {
  return {
    name: input.programTitle,
    quantity: "1",
    base_price_money: {
      amount: input.amountCents,
      currency: "CAD",
    },
    note: "Training enrollment with Ontario HST",
  };
}

function splitCustomerName(customerName: string): { familyName: string; givenName: string } {
  const [givenName = customerName, ...familyParts] = customerName.split(" ");

  return {
    givenName,
    familyName: familyParts.join(" "),
  };
}

function parseProgramSlug(body: unknown): string | null {
  if (!isRecord(body) || typeof body.programSlug !== "string") {
    return null;
  }

  const programSlug = body.programSlug.trim();

  return programSlug.length > 0 ? programSlug : null;
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function toStableId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function getReferenceIdFromMockOrderId(orderId: string): string | undefined {
  const prefix = "mock-square-invoice-order-";

  return orderId.startsWith(prefix) ? orderId.slice(prefix.length) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidTrainingSquareInvoiceRequest(): NextResponse<TrainingSquareInvoiceErrorBody> {
  return NextResponse.json<TrainingSquareInvoiceErrorBody>(
    { error: "Invalid training checkout request" },
    { status: 400 },
  );
}

function unavailableTrainingSquareInvoiceResponse(): NextResponse<TrainingSquareInvoiceErrorBody> {
  return NextResponse.json<TrainingSquareInvoiceErrorBody>(
    { error: "Training Square invoice checkout is unavailable" },
    { status: 404 },
  );
}
