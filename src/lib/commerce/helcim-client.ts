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
  const response = await fetch(`${HELCIM_API_BASE_URL}${path}`, {
    method: "GET",
    headers: {
      "api-token": apiToken,
      accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Helcim API request failed with status ${response.status}`);
  }

  return (await response.json()) as TResponse;
}

async function postHelcim<TRequest, TResponse>(
  path: string,
  request: TRequest,
  apiToken: string,
): Promise<TResponse> {
  const response = await fetch(`${HELCIM_API_BASE_URL}${path}`, {
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
    throw new Error(`Helcim API request failed with status ${response.status}`);
  }

  return (await response.json()) as TResponse;
}
