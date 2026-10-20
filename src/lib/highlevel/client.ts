import "server-only";
import { accessToken } from "./oauth";
import { HIGHLEVEL_ORIGIN } from "./config";
import { HighLevelError } from "./contract";

export type CrmRequest = <T = Record<string, unknown>>(
  path: string,
  options?: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    nonIdempotent?: boolean;
  },
) => Promise<T>;

export function createHighLevelClient(
  getToken: () => Promise<string> = accessToken,
  request: typeof fetch = fetch,
): CrmRequest {
  return async function call<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      nonIdempotent?: boolean;
    } = {},
  ): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
      throw new HighLevelError("invalid_api_path");
    const token = await getToken();
    let response: Response;
    try {
      response = await request(`${HIGHLEVEL_ORIGIN}${path}`, {
        method: options.method ?? "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Version: "v3",
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      });
    } catch {
      throw new HighLevelError(
        "highlevel_network_error",
        !options.nonIdempotent,
        60,
        options.nonIdempotent,
      );
    }
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const delay =
        retryAfter && /^\d+$/.test(retryAfter)
          ? Number(retryAfter)
          : retryAfter
            ? Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)
            : 60;
      const ambiguous = Boolean(
        options.nonIdempotent &&
        (response.status === 408 || response.status >= 500),
      );
      throw new HighLevelError(
        `highlevel_http_${response.status}`,
        !ambiguous &&
          (response.status === 408 ||
            response.status === 429 ||
            response.status >= 500),
        Math.min(86400, Math.max(1, Number.isFinite(delay) ? delay : 60)),
        ambiguous,
      );
    }
    if (response.status === 204) return {} as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new HighLevelError(
        "highlevel_invalid_response",
        !options.nonIdempotent,
        60,
        options.nonIdempotent,
      );
    }
  };
}
export const highlevel = createHighLevelClient();
