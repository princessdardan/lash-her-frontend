export class LearningRequestError extends Error {
  constructor(readonly code: string, readonly status: number, readonly requestId?: string) {
    super("Learning request could not be completed.");
    this.name = "LearningRequestError";
  }
}

/** Only our named same-origin handlers use this browser transport. API bearer
 * credentials and service origins never enter component props or storage. */
export async function learningRequest<T>(path: string, options: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal; keepalive?: boolean } = {}): Promise<T> {
  const response = await fetch(path, { method: options.method ?? "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: options.signal,
    ...(options.method === "POST" ? { headers: { "content-type": "application/json", "x-lash-csrf": "1" }, body: JSON.stringify(options.body), keepalive: options.keepalive } : {}) });
  let body: unknown;
  try { body = await response.json(); } catch { throw new LearningRequestError("service_unavailable", 503); }
  if (!response.ok) {
    const codes = ["invalid_request", "sign_in_required", "forbidden", "not_found", "access_required", "access_revoked", "course_archived", "video_processing", "video_unavailable", "conflict", "rate_limited", "feature_disabled", "service_unavailable"];
    const envelope = body as { error?: { code?: unknown }; requestId?: unknown } | null;
    const code = typeof envelope?.error?.code === "string" && codes.includes(envelope.error.code) ? envelope.error.code : "service_unavailable";
    const id = typeof envelope?.requestId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(envelope.requestId) ? envelope.requestId : undefined;
    throw new LearningRequestError(code, response.status, id);
  }
  return body as T; // The server validates the pinned response before forwarding.
}

export function learningErrorText(error: unknown): string {
  const code = error instanceof LearningRequestError ? error.code : "service_unavailable";
  switch (code) {
    case "sign_in_required": return "Your session has ended. Sign in again to continue.";
    case "access_required": return "Enrollment is required to continue.";
    case "access_revoked": return "Your access has ended. Open your academy to check your current courses.";
    case "course_archived": return "This course is archived and cannot be opened for learning.";
    case "forbidden": return "Your account cannot complete this action. Check your account status or contact support.";
    case "conflict": return "This lesson changed in another session. Reload the latest version before continuing.";
    case "rate_limited": return "Please wait before trying again.";
    default: return "The learning service is temporarily unavailable. Try again in a moment.";
  }
}
