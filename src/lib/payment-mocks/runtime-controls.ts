import { assertPaymentMockScenario, type PaymentMockScenario } from "./scenarios";

export interface PaymentMockRuntimeEnvironment {
  NODE_ENV?: string;
  PAYMENT_GATEWAY_MODE?: string;
  PAYMENT_MOCK_DEFAULT_SCENARIO?: string;
  VERCEL_ENV?: string;
}

export interface ResolvePaymentMockScenarioInput {
  env: PaymentMockRuntimeEnvironment;
  injectedScenario?: string | null;
  now: Date;
  request: Request;
}

export interface AssertPaymentMockAllowedInput {
  env: PaymentMockRuntimeEnvironment;
  injectedScenario?: string | null;
  request: Request;
}

const paymentMockScenarioHeader = "x-lash-payment-mock-scenario";
const paymentMockScenarioQueryParam = "mockPaymentScenario";
const productionGuardMessage = "Payment mock mode is not allowed in production";
const requestControlGuardMessage = "Payment mock controls require PAYMENT_GATEWAY_MODE=mock";

export type PaymentGatewayMode = "live" | "mock";

export function resolvePaymentMockScenario(input: ResolvePaymentMockScenarioInput): PaymentMockScenario {
  assertPaymentMockAllowed({ env: input.env, request: input.request, injectedScenario: input.injectedScenario });

  const injectedScenario = resolveScenarioValue(input.injectedScenario);
  if (injectedScenario) {
    return injectedScenario;
  }

  const headerScenario = resolveScenarioValue(input.request.headers.get(paymentMockScenarioHeader));
  if (headerScenario) {
    return headerScenario;
  }

  const queryScenario = resolveScenarioValue(new URL(input.request.url).searchParams.get(paymentMockScenarioQueryParam));
  if (queryScenario) {
    return queryScenario;
  }

  const envScenario = resolveScenarioValue(input.env.PAYMENT_MOCK_DEFAULT_SCENARIO);
  if (envScenario) {
    return envScenario;
  }

  return "success";
}

export function assertPaymentMockAllowed(input: AssertPaymentMockAllowedInput): void {
  const mode = resolvePaymentGatewayMode(input.env);
  const hasRequestControls = hasPaymentMockRequestControls(input.request);
  const production = isPaymentMockProductionEnvironment(input.env);

  if (production && (
    input.injectedScenario !== undefined
    || input.env.PAYMENT_MOCK_DEFAULT_SCENARIO !== undefined
    || hasRequestControls
  )) {
    throw new Error(productionGuardMessage);
  }

  if (mode !== "mock" && hasRequestControls) {
    throw new Error(requestControlGuardMessage);
  }
}

export function resolvePaymentGatewayMode(env: PaymentMockRuntimeEnvironment): PaymentGatewayMode {
  const mode = env.PAYMENT_GATEWAY_MODE ?? "live";

  if (mode !== "live" && mode !== "mock") {
    throw new Error("Malformed env var: PAYMENT_GATEWAY_MODE must be live or mock");
  }

  if (mode === "mock" && isPaymentMockProductionEnvironment(env)) {
    throw new Error(productionGuardMessage);
  }

  return mode;
}

export function isPaymentMockProductionEnvironment(env: PaymentMockRuntimeEnvironment): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

function resolveScenarioValue(value: string | null | undefined): PaymentMockScenario | null {
  if (value === null || value === undefined) {
    return null;
  }

  return assertPaymentMockScenario(value);
}

function hasPaymentMockRequestControls(request: Request): boolean {
  return request.headers.has(paymentMockScenarioHeader)
    || new URL(request.url).searchParams.has(paymentMockScenarioQueryParam);
}
