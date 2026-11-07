export class AuthoringRequestError extends Error {
  constructor(
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(
      status === 409
        ? "This course changed or is not ready for this operation. Reload before trying again."
        : status === 401
          ? "Your admin session ended. Sign in again."
          : status === 403
            ? "You do not have permission to edit courses."
            : status === 400
              ? "Check the fields and try again."
              : "The course service is unavailable. Your changes have not been confirmed.",
    );
    this.name = "AuthoringRequestError";
  }
}
export function nextAuthoringKey(prefix: string, siblingKeys: readonly string[]): string {
  const occupied = new Set(siblingKeys);
  let index = 1;
  while (occupied.has(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
}
export async function authoringRequest<T>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" = "GET",
  body?: unknown,
): Promise<T> {
  if (
    !/^\/api\/admin\/[A-Za-z0-9/%_-]+$/u.test(path) ||
    path.includes("//") ||
    /%2f|%5c|%2e/iu.test(path)
  )
    throw new AuthoringRequestError(400);
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      cache: "no-store",
      credentials: "same-origin",
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
      headers: {
        ...(method !== "GET"
          ? { "content-type": "application/json", "x-lash-csrf": "1" }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new AuthoringRequestError(503);
  }
  const requestId = response.headers.get("x-request-id") ?? undefined;
  if (!response.ok)
    throw new AuthoringRequestError(
      response.status,
      requestId && /^[a-f0-9-]{36}$/u.test(requestId) ? requestId : undefined,
    );
  if (
    response.headers.get("content-type")?.split(";", 1)[0] !==
    "application/json"
  )
    throw new AuthoringRequestError(503);
  // The explicit same-origin handler validates its pinned receiver schema.
  try {
    return (await response.json()) as T;
  } catch {
    throw new AuthoringRequestError(503);
  }
}
