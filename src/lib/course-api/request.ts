import "server-only";

import { randomUUID } from "node:crypto";

import type { EnabledCourseApiConfig } from "./config";
import {
  CourseApiContractError,
  parseCourseApiErrorEnvelope,
} from "./contracts";
import { CourseApiError } from "./errors";

const MAX_RESPONSE_CHARACTERS = 1_000_000;
const MAX_ERROR_RESPONSE_CHARACTERS = 16_384;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export interface CourseApiRequestRuntime {
  fetch?: typeof fetch;
  createRequestId?: () => string;
  nowMilliseconds?: () => number;
}

export interface CourseApiRequestContext {
  signal?: AbortSignal;
  correlationId?: string;
}

export interface CourseApiRequestOptions<T> {
  config: EnabledCourseApiConfig;
  path: string;
  method?: "GET" | "POST";
  token?: string;
  body?: unknown;
  cache?: RequestCache;
  signal?: AbortSignal;
  correlationId?: string;
  parse: (value: unknown) => T;
  runtime?: CourseApiRequestRuntime;
}

export async function requestCourseApi<T>(
  options: CourseApiRequestOptions<T>,
): Promise<T> {
  const runtime = options.runtime ?? {};
  const requestId =
    validRequestId(options.correlationId ?? null) ??
    validRequestId((runtime.createRequestId ?? randomUUID)()) ??
    randomUUID();
  const headers = new Headers({
    accept: "application/json",
    "x-request-id": requestId,
  });
  if (options.token !== undefined)
    headers.set("authorization", `Bearer ${options.token}`);

  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }

  const combined = combineAbortSignals(
    options.signal,
    options.config.timeoutMs,
  );
  let response: Response;
  try {
    response = await (runtime.fetch ?? fetch)(
      `${options.config.baseUrl}${options.path}`,
      {
        method: options.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
        ...(options.cache === undefined ? {} : { cache: options.cache }),
        signal: combined.signal,
      },
    );
  } catch {
    combined.cleanup();
    if (combined.didTimeout()) {
      throw new CourseApiError("Course API request timed out", {
        kind: "timeout",
        retryable: true,
        requestId,
      });
    }
    if (options.signal?.aborted) {
      throw new CourseApiError("Course API request was aborted", {
        kind: "aborted",
        requestId,
      });
    }
    throw new CourseApiError(
      "Course API request failed before receiving a response",
      {
        kind: "network",
        retryable: true,
        requestId,
      },
    );
  }

  try {
    const responseRequestId = responseRequestIdentifier(response) ?? requestId;
    if (!response.ok) {
      throw await responseError(
        response,
        responseRequestId,
        runtime.nowMilliseconds,
      );
    }

    let value: unknown;
    try {
      value = await parseJsonResponse(response, MAX_RESPONSE_CHARACTERS);
    } catch {
      throw new CourseApiError("Course API returned an invalid JSON response", {
        kind: "invalid_response",
        status: response.status,
        requestId: responseRequestId,
      });
    }

    try {
      return options.parse(value);
    } catch (error) {
      if (!(error instanceof CourseApiContractError)) throw error;
      throw new CourseApiError(
        "Course API returned a response that did not match its contract",
        {
          kind: "invalid_response",
          status: response.status,
          requestId: responseRequestId,
        },
      );
    }
  } finally {
    combined.cleanup();
  }
}

async function responseError(
  response: Response,
  requestId: string,
  nowMilliseconds: (() => number) | undefined,
): Promise<CourseApiError> {
  let value: unknown = null;
  try {
    value = await parseJsonResponse(response, MAX_ERROR_RESPONSE_CHARACTERS);
  } catch {
    // Error bodies are deliberately discarded unless they match the bounded envelope.
  }
  const envelope = parseCourseApiErrorEnvelope(value);
  const classification = classifyStatus(response.status);

  return new CourseApiError(
    `Course API request failed with status ${response.status}`,
    {
      ...classification,
      status: response.status,
      upstreamCode: envelope?.error.code ?? null,
      retryAfter: parseRetryAfter(
        response.headers.get("retry-after"),
        nowMilliseconds,
      ),
      requestId,
    },
  );
}

function classifyStatus(status: number): {
  kind: CourseApiError["kind"];
  retryable: boolean;
} {
  if (status === 401 || status === 403)
    return { kind: "auth", retryable: false };
  if (status === 429) return { kind: "rate_limit", retryable: true };
  if (status >= 500) return { kind: "upstream", retryable: true };
  return { kind: "request", retryable: false };
}

async function parseJsonResponse(
  response: Response,
  maximumCharacters: number,
): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0 || text.length > maximumCharacters)
    throw new Error("Invalid response size");
  return JSON.parse(text);
}

function parseRetryAfter(
  value: string | null,
  nowMilliseconds: (() => number) | undefined,
): number | null {
  if (value === null) return null;
  if (/^[0-9]+$/u.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  const now = (nowMilliseconds ?? Date.now)();
  return Math.max(0, Math.ceil((timestamp - now) / 1_000));
}

function responseRequestIdentifier(response: Response): string | null {
  return (
    validRequestId(response.headers.get("x-request-id")) ??
    validRequestId(response.headers.get("x-correlation-id"))
  );
}

function validRequestId(value: string | null): string | null {
  return value !== null && REQUEST_ID_PATTERN.test(value) ? value : null;
}

function combineAbortSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Timed out", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}
