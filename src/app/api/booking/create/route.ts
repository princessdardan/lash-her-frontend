const DIRECT_BOOKING_DISABLED_ERROR = "Appointments require secure payment before Calendar confirmation.";

export function createBookingCreatePostHandler(
  dependencies: Record<string, never> = {},
): (req: Request) => Promise<Response> {
  void dependencies;

  return async function bookingCreatePostHandler(
    req: Request,
  ): Promise<Response> {
    try {
      await req.json();
    } catch (error) {
      console.warn("[booking create] Invalid JSON:", getErrorMessage(error));

      return Response.json(
        { success: false, error: "Invalid booking request" },
        { status: 400 },
      );
    }

    return Response.json(
      { success: false, error: DIRECT_BOOKING_DISABLED_ERROR },
      { status: 400 },
    );
  };
}

export const POST = createBookingCreatePostHandler();

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
