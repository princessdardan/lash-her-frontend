import { log } from "@/lib/logging/logger";
import {
  CHECKOUT_CUSTOMER_NAME_MAX_LENGTH,
  isValidCheckoutEmail,
  parseCheckoutText,
} from "@/lib/commerce/checkout-validation";
import {
  COURSE_CHECKOUT_SLUG_MAX_LENGTH,
  CourseCheckoutError,
  createCourseCheckout,
  isValidCourseSlug,
  type CourseCheckoutInput,
  type CourseCheckoutResult,
} from "@/lib/course-commerce/course-checkout";

const MAX_REQUEST_BODY_CHARACTERS = 4_096;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface CourseCheckoutRequestBody {
  courseSlug: string;
  customer: {
    email: string;
    name: string;
  };
}

export interface VerifiedCourseCheckoutSession {
  customerUserId: string;
  email: string;
}

export class CourseCheckoutSessionError extends Error {
  constructor() {
    super("Customer session cannot be used for course checkout");
    this.name = "CourseCheckoutSessionError";
  }
}

export interface CourseCheckoutPostHandlerDependencies {
  getVerifiedCustomerSession(): Promise<VerifiedCourseCheckoutSession | null>;
  isActiveCustomerUser(customerUserId: string): Promise<boolean>;
  startCheckout(input: CourseCheckoutInput): Promise<CourseCheckoutResult>;
  reportError?: (error: unknown) => void;
}

export function createCourseCheckoutPostHandler(
  dependencies: CourseCheckoutPostHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async function courseCheckoutPostHandler(request) {
    const checkoutRequest = await parseRequest(request);
    if (checkoutRequest === null) {
      return jsonError("Invalid course checkout request", 400);
    }

    try {
      const verifiedSession = await dependencies.getVerifiedCustomerSession();
      if (verifiedSession === null) {
        return jsonError("Sign in is required for course checkout", 401);
      }

      const isActive = await dependencies.isActiveCustomerUser(
        verifiedSession.customerUserId,
      );
      if (
        !isActive ||
        verifiedSession.email !== checkoutRequest.customer.email
      ) {
        throw new CourseCheckoutSessionError();
      }

      const result = await dependencies.startCheckout({
        courseSlug: checkoutRequest.courseSlug,
        customer: {
          email: verifiedSession.email,
          name: checkoutRequest.customer.name,
        },
        customerUserId: verifiedSession.customerUserId,
        signal: request.signal,
      });

      return Response.json(result, {
        headers: { "cache-control": "no-store" },
      });
    } catch (error) {
      dependencies.reportError?.(error);

      if (error instanceof CourseCheckoutSessionError) {
        return jsonError(
          "Customer session cannot be used for course checkout",
          403,
        );
      }
      if (error instanceof CourseCheckoutError) {
        if (error.code === "INVALID_INPUT") {
          return jsonError("Invalid course checkout request", 400);
        }
        if (error.code === "COURSE_UNAVAILABLE") {
          return jsonError("Course is not available for purchase", 409);
        }
        if (error.code === "INVALID_PROVIDER_RESPONSE") {
          return jsonError("Unable to start course checkout", 502);
        }
        if (error.code === "CHECKOUT_DISABLED") {
          return jsonError("Course checkout is unavailable", 503);
        }
      }

      return jsonError("Unable to start course checkout", 503);
    }
  };
}

export function verifiedCustomerFromSession(
  session: unknown,
): VerifiedCourseCheckoutSession | null {
  if (!isRecord(session) || !isRecord(session.user)) return null;
  if (session.user.id === undefined) return null;

  const email =
    typeof session.user.email === "string"
      ? session.user.email.trim().toLowerCase()
      : "";
  if (
    session.user.isEmailVerified !== true ||
    typeof session.user.id !== "string" ||
    !UUID_PATTERN.test(session.user.id) ||
    !isValidCheckoutEmail(email)
  ) {
    throw new CourseCheckoutSessionError();
  }

  return {
    customerUserId: session.user.id,
    email,
  };
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.COURSE_CHECKOUT_ENABLED !== "true") {
    return jsonError("Course checkout is unavailable", 503);
  }

  return createCourseCheckoutPostHandler({
    getVerifiedCustomerSession: async () => {
      const { auth } = await import("@/auth");
      return verifiedCustomerFromSession(await auth());
    },
    isActiveCustomerUser: async (customerUserId) => {
      const { isActiveCustomerUser } =
        await import("@/lib/customer-identity/status");
      return isActiveCustomerUser(customerUserId);
    },
    startCheckout: (input) => startConfiguredCourseCheckout(input, request),
    reportError(error) {
      log("error", "[course-checkout] Unable to initialize checkout", {
        errorCode:
          error instanceof CourseCheckoutError
            ? error.code
            : error instanceof CourseCheckoutSessionError
              ? "CUSTOMER_SESSION_INVALID"
              : "UNEXPECTED_ERROR",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    },
  })(request);
}

async function startConfiguredCourseCheckout(
  input: CourseCheckoutInput,
  request: Request,
): Promise<CourseCheckoutResult> {
  if (process.env.COURSE_CHECKOUT_ENABLED !== "true") {
    throw new CourseCheckoutError(
      "CHECKOUT_DISABLED",
      "Course checkout is disabled",
    );
  }

  const [configModule, errorModule] = await Promise.all([
    import("@/lib/course-api/config"),
    import("@/lib/course-api/errors"),
  ]);
  let config;
  try {
    config = configModule.requireEnabledCourseApiConfig(
      configModule.readCourseApiConfig(),
    );
  } catch (error) {
    if (
      error instanceof errorModule.CourseApiError &&
      error.kind === "config"
    ) {
      throw new CourseCheckoutError(
        "CHECKOUT_DISABLED",
        "Course checkout configuration is unavailable",
      );
    }
    throw error;
  }

  const [
    { createPublicCourseClient },
    { createDrizzleCourseCheckoutRepository },
    checkoutModule,
  ] = await Promise.all([
    import("@/lib/course-api/public-client"),
    import("@/lib/course-commerce/course-checkout-repository"),
    import("@/app/api/checkout/handler"),
  ]);
  const publicCourseClient = createPublicCourseClient(config);
  const helcimGateway =
    await checkoutModule.resolveCheckoutHelcimGatewayForRequest(request);

  return createCourseCheckout({
    async getPublishedCourseBySlug(slug, signal) {
      try {
        return await publicCourseClient.getCourseBySlug(slug, { signal });
      } catch (error) {
        if (
          error instanceof errorModule.CourseApiError &&
          error.status === 404
        ) {
          throw new CourseCheckoutError(
            "COURSE_UNAVAILABLE",
            "Course is not available for purchase",
          );
        }
        throw error;
      }
    },
    helcimGateway,
    repository: createDrizzleCourseCheckoutRepository(),
  })(input);
}

async function parseRequest(
  request: Request,
): Promise<CourseCheckoutRequestBody | null> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (/^[0-9]+$/u.test(contentLength) === false ||
      Number(contentLength) > MAX_REQUEST_BODY_CHARACTERS)
  ) {
    return null;
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return null;
  }
  if (rawBody.length === 0 || rawBody.length > MAX_REQUEST_BODY_CHARACTERS) {
    return null;
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(body) || !isRecord(body.customer)) return null;

  const courseSlug =
    typeof body.courseSlug === "string" ? body.courseSlug.trim() : "";
  const name = parseCheckoutText(
    body.customer.name,
    CHECKOUT_CUSTOMER_NAME_MAX_LENGTH,
  );
  const email =
    typeof body.customer.email === "string"
      ? body.customer.email.trim().toLowerCase()
      : "";

  if (
    courseSlug.length > COURSE_CHECKOUT_SLUG_MAX_LENGTH ||
    !isValidCourseSlug(courseSlug) ||
    name === null ||
    !isValidCheckoutEmail(email)
  ) {
    return null;
  }

  return {
    courseSlug,
    customer: { email, name },
  };
}

function jsonError(error: string, status: number): Response {
  return Response.json(
    { error },
    { headers: { "cache-control": "no-store" }, status },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
