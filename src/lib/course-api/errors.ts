import "server-only";

export type CourseApiErrorKind =
  | "aborted"
  | "auth"
  | "config"
  | "invalid_response"
  | "network"
  | "rate_limit"
  | "request"
  | "timeout"
  | "upstream";

export interface CourseApiErrorOptions {
  kind: CourseApiErrorKind;
  status?: number | null;
  upstreamCode?: string | null;
  retryable?: boolean;
  retryAfter?: number | null;
  requestId?: string | null;
}

export class CourseApiError extends Error {
  readonly kind: CourseApiErrorKind;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly retryAfter: number | null;
  readonly status: number | null;
  readonly upstreamCode: string | null;

  constructor(message: string, options: CourseApiErrorOptions) {
    super(message);
    this.name = "CourseApiError";
    this.kind = options.kind;
    this.status = options.status ?? null;
    this.upstreamCode = options.upstreamCode ?? null;
    this.retryable = options.retryable ?? false;
    this.retryAfter = options.retryAfter ?? null;
    this.requestId = options.requestId ?? null;
  }
}

export function courseApiConfigError(message: string): CourseApiError {
  return new CourseApiError(message, { kind: "config" });
}
