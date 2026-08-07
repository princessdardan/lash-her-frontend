import "server-only";

import type { HelcimGateway } from "@/lib/commerce/helcim-gateway";
import {
  CHECKOUT_CUSTOMER_NAME_MAX_LENGTH,
  isValidCheckoutEmail,
  parseCheckoutText,
} from "@/lib/commerce/checkout-validation";
import type { PublicCourseDetail } from "@/lib/course-api/contracts";

export const COURSE_CHECKOUT_SLUG_MAX_LENGTH = 120;
export const COURSE_CHECKOUT_TITLE_MAX_LENGTH = 240;

const COURSE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_IDENTIFIER_MAX_LENGTH = 512;
const PROVIDER_TOKEN_MAX_LENGTH = 4_096;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;

export interface CourseCheckoutCustomer {
  email: string;
  name: string;
}

export interface CourseCheckoutInput {
  courseSlug: string;
  customer: CourseCheckoutCustomer;
  customerUserId: string | null;
  signal?: AbortSignal;
}

export interface PersistPendingCourseCheckoutInput {
  checkoutToken: string;
  course: Pick<
    PublicCourseDetail,
    "currency" | "id" | "priceCents" | "slug" | "title"
  >;
  customerEmail: string;
  customerName: string;
  customerUserId: string | null;
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
  secretToken: string;
}

export interface CourseCheckoutRepository {
  persistPendingCheckout(
    input: PersistPendingCourseCheckoutInput,
  ): Promise<{ orderId: string }>;
}

export interface CourseCheckoutDependencies {
  getPublishedCourseBySlug(
    slug: string,
    signal?: AbortSignal,
  ): Promise<PublicCourseDetail>;
  helcimGateway: Pick<HelcimGateway, "createInvoice" | "initializePay">;
  repository: CourseCheckoutRepository;
}

export interface CourseCheckoutResult {
  checkoutToken: string;
  orderId: string;
}

export type CourseCheckoutErrorCode =
  | "CHECKOUT_DISABLED"
  | "COURSE_UNAVAILABLE"
  | "INVALID_INPUT"
  | "INVALID_PROVIDER_RESPONSE";

export class CourseCheckoutError extends Error {
  constructor(
    readonly code: CourseCheckoutErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CourseCheckoutError";
  }
}

export function createCourseCheckout(
  dependencies: CourseCheckoutDependencies,
): (input: CourseCheckoutInput) => Promise<CourseCheckoutResult> {
  return async function courseCheckout(input) {
    const parsedInput = parseCourseCheckoutInput(input);
    const course = validatePurchasableCourse(
      await dependencies.getPublishedCourseBySlug(
        parsedInput.courseSlug,
        input.signal,
      ),
      parsedInput.courseSlug,
    );
    const amount = course.priceCents / 100;

    const invoice = validateInvoiceResponse(
      await dependencies.helcimGateway.createInvoice({
        currency: "CAD",
        lineItems: [
          {
            description: course.title,
            price: amount,
            quantity: 1,
            sku: course.slug,
          },
        ],
        notes: "Lash Her course checkout",
        status: "DUE",
        type: "INVOICE",
      }),
    );
    const paySession = validatePaySessionResponse(
      await dependencies.helcimGateway.initializePay({
        amount,
        currency: "CAD",
        invoiceNumber: invoice.invoiceNumber,
        paymentType: "purchase",
      }),
    );
    const persisted = await dependencies.repository.persistPendingCheckout({
      checkoutToken: paySession.checkoutToken,
      course,
      customerEmail: parsedInput.customer.email,
      customerName: parsedInput.customer.name,
      customerUserId: parsedInput.customerUserId,
      helcimInvoiceId: invoice.invoiceId,
      helcimInvoiceNumber: invoice.invoiceNumber,
      secretToken: paySession.secretToken,
    });

    return {
      checkoutToken: paySession.checkoutToken,
      orderId: persisted.orderId,
    };
  };
}

export function isValidCourseSlug(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= COURSE_CHECKOUT_SLUG_MAX_LENGTH &&
    COURSE_SLUG_PATTERN.test(value)
  );
}

function parseCourseCheckoutInput(
  input: CourseCheckoutInput,
): CourseCheckoutInput {
  const courseSlug =
    typeof input.courseSlug === "string" ? input.courseSlug.trim() : "";
  const name = parseCheckoutText(
    input.customer?.name,
    CHECKOUT_CUSTOMER_NAME_MAX_LENGTH,
  );
  const email =
    typeof input.customer?.email === "string"
      ? input.customer.email.trim().toLowerCase()
      : "";
  const customerUserId = input.customerUserId;

  if (
    !isValidCourseSlug(courseSlug) ||
    name === null ||
    !isValidCheckoutEmail(email) ||
    (customerUserId !== null && !UUID_PATTERN.test(customerUserId))
  ) {
    throw new CourseCheckoutError(
      "INVALID_INPUT",
      "Invalid course checkout input",
    );
  }

  return {
    courseSlug,
    customer: { email, name },
    customerUserId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function validatePurchasableCourse(
  course: PublicCourseDetail,
  requestedSlug: string,
): PublicCourseDetail {
  const title = course.title.trim();

  // The public Course API endpoint is the publication boundary. Local checks
  // prevent malformed or non-purchasable data from reaching Helcim.
  if (
    !UUID_PATTERN.test(course.id) ||
    course.slug !== requestedSlug ||
    !isValidCourseSlug(course.slug) ||
    title.length === 0 ||
    title.length > COURSE_CHECKOUT_TITLE_MAX_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(course.title) ||
    course.currency !== "CAD" ||
    !Number.isSafeInteger(course.priceCents) ||
    course.priceCents <= 0
  ) {
    throw new CourseCheckoutError(
      "COURSE_UNAVAILABLE",
      "Course is not available for purchase",
    );
  }

  return { ...course, title };
}

function validateInvoiceResponse(value: unknown): {
  invoiceId: number;
  invoiceNumber: string;
} {
  if (
    !isRecord(value) ||
    typeof value.invoiceId !== "number" ||
    !Number.isSafeInteger(value.invoiceId) ||
    value.invoiceId <= 0 ||
    !isValidProviderValue(value.invoiceNumber, PROVIDER_IDENTIFIER_MAX_LENGTH)
  ) {
    throw new CourseCheckoutError(
      "INVALID_PROVIDER_RESPONSE",
      "Helcim invoice response was invalid",
    );
  }

  return {
    invoiceId: value.invoiceId,
    invoiceNumber: value.invoiceNumber,
  };
}

function validatePaySessionResponse(value: unknown): {
  checkoutToken: string;
  secretToken: string;
} {
  if (
    !isRecord(value) ||
    !isValidProviderValue(value.checkoutToken, PROVIDER_TOKEN_MAX_LENGTH) ||
    !isValidProviderValue(value.secretToken, PROVIDER_TOKEN_MAX_LENGTH)
  ) {
    throw new CourseCheckoutError(
      "INVALID_PROVIDER_RESPONSE",
      "Helcim Pay response was invalid",
    );
  }

  return {
    checkoutToken: value.checkoutToken,
    secretToken: value.secretToken,
  };
}

function isValidProviderValue(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
