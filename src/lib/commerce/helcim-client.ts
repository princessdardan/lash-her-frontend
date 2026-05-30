import "server-only";

import {
  getHelcimGeneralApiToken,
  getHelcimTransactionApiToken,
} from "@/sanity/env";

import type {
  HelcimCardTransactionResponse,
  HelcimInvoiceRequest,
  HelcimInvoiceResponse,
  HelcimPayInitializeRequest,
  HelcimPayInitializeResponse,
} from "./helcim-types";

const HELCIM_API_BASE_URL = "https://api.helcim.com/v2";
const HELCIM_API_TIMEOUT_MS = 10_000;

export class HelcimApiError extends Error {
  readonly path: string;
  readonly responseError: string | null;
  readonly status: number;

  constructor({
    path,
    responseError,
    status,
  }: {
    path: string;
    responseError: string | null;
    status: number;
  }) {
    super(
      `Helcim API request failed with status ${status} for ${path}${responseError ? `: ${responseError}` : ""}`
    );
    this.name = "HelcimApiError";
    this.path = path;
    this.responseError = responseError;
    this.status = status;
  }
}

export async function createHelcimInvoice(
  request: HelcimInvoiceRequest,
): Promise<HelcimInvoiceResponse> {
  return postHelcim<HelcimInvoiceRequest, HelcimInvoiceResponse>(
    "/invoices/",
    request,
    getHelcimGeneralApiToken(),
  );
}

export async function initializeHelcimPay(
  request: HelcimPayInitializeRequest,
): Promise<HelcimPayInitializeResponse> {
  return postHelcim<HelcimPayInitializeRequest, HelcimPayInitializeResponse>(
    "/helcim-pay/initialize",
    request,
    getHelcimTransactionApiToken(),
  );
}

export async function getHelcimCardTransaction(
  cardTransactionId: string,
): Promise<HelcimCardTransactionResponse> {
  return getHelcim<HelcimCardTransactionResponse>(
    `/card-transactions/${encodeURIComponent(cardTransactionId)}`,
    getHelcimGeneralApiToken(),
  );
}

async function getHelcim<TResponse>(path: string, apiToken: string): Promise<TResponse> {
  const response = await fetchHelcim(`${HELCIM_API_BASE_URL}${path}`, {
    method: "GET",
    headers: {
      "api-token": apiToken,
      accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw await createHelcimApiError(path, response);
  }

  return (await response.json()) as TResponse;
}

async function postHelcim<TRequest, TResponse>(
  path: string,
  request: TRequest,
  apiToken: string,
): Promise<TResponse> {
  const response = await fetchHelcim(`${HELCIM_API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "api-token": apiToken,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
    cache: "no-store",
  });

  if (!response.ok) {
    throw await createHelcimApiError(path, response);
  }

  return (await response.json()) as TResponse;
}

async function fetchHelcim(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HELCIM_API_TIMEOUT_MS);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function createHelcimApiError(path: string, response: Response): Promise<HelcimApiError> {
  return new HelcimApiError({
    path,
    responseError: summarizeHelcimErrorBody(await response.text()),
    status: response.status,
  });
}

function summarizeHelcimErrorBody(body: string): string | null {
  const trimmed = body.trim();

  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const messages = collectHelcimErrorMessages(parsed);

    if (messages.length > 0) {
      return limitHelcimErrorSummary(messages.join("; "));
    }
  } catch {
    return limitHelcimErrorSummary(trimmed);
  }

  return limitHelcimErrorSummary(trimmed);
}

function collectHelcimErrorMessages(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();

    return trimmed.length > 0 ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectHelcimErrorMessages);
  }

  if (isRecord(value)) {
    if (typeof value.message === "string") {
      return collectHelcimErrorMessages(value.message);
    }

    if ("errors" in value) {
      return collectHelcimErrorMessages(value.errors);
    }

    return Object.values(value).flatMap(collectHelcimErrorMessages);
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limitHelcimErrorSummary(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}
