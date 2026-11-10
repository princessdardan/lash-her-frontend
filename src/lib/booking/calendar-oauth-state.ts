import { markWriterOperationUncertain } from "@/lib/writer-admission/context";

const CONSUME_VALUE_SCRIPT = `#!lua flags=allow-key-locking
local value = redis.call("GET", KEYS[1])
if not value then
  return {0}
end
redis.call("DEL", KEYS[1])
return {1, value}`;

export interface BookingCalendarOAuthState {
  actorAdminUserId: string;
  connectionId: string;
  flowType: "admin" | "employee";
  resourceId: string | null;
  returnTo: string;
}

export interface BookingCalendarOAuthStateStorage {
  eval<TArgs extends unknown[], TResult>(
    script: string,
    keys: string[],
    args: TArgs,
  ): Promise<TResult>;
  set(
    key: string,
    value: string,
    options: { ex: number; nx: true },
  ): Promise<unknown>;
}

export async function saveBookingCalendarOAuthState(
  input: {
    state: string;
    payload: BookingCalendarOAuthState;
    ttlSeconds: number;
  },
  storage: BookingCalendarOAuthStateStorage,
): Promise<boolean> {
  assertOAuthState(input.state);
  assertOAuthStatePayload(input.payload);

  const result = await storage.set(
    toBookingCalendarOAuthStateKey(input.state),
    JSON.stringify(input.payload),
    { ex: input.ttlSeconds, nx: true },
  );

  return result === "OK";
}

export async function consumeBookingCalendarOAuthState(
  state: string,
  storage: BookingCalendarOAuthStateStorage,
): Promise<BookingCalendarOAuthState | null> {
  assertOAuthState(state);

  const receipt = await storage.eval<[], unknown>(
    CONSUME_VALUE_SCRIPT,
    [toBookingCalendarOAuthStateKey(state)],
    [],
  );

  // The tag distinguishes a miss from a deleted value that deserializes to null.
  if (Array.isArray(receipt) && receipt.length === 1 && receipt[0] === 0) return null;
  if (!Array.isArray(receipt) || receipt.length !== 2 || receipt[0] !== 1) {
    markWriterOperationUncertain();
    return null;
  }

  let payload: unknown = receipt[1];
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      markWriterOperationUncertain();
      return null;
    }
  }

  if (isBookingCalendarOAuthState(payload)) return payload;
  markWriterOperationUncertain();
  return null;
}

export function isBookingCalendarOAuthState(
  value: unknown,
): value is BookingCalendarOAuthState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const flowType = candidate.flowType;
  const expectedReturnTo =
    flowType === "employee"
      ? "/admin/my-calendar"
      : "/admin/calendar-connections";

  return (
    typeof candidate.actorAdminUserId === "string" &&
    candidate.actorAdminUserId.length > 0 &&
    typeof candidate.connectionId === "string" &&
    candidate.connectionId.length > 0 &&
    (flowType === "admin" || flowType === "employee") &&
    (candidate.resourceId === null ||
      (typeof candidate.resourceId === "string" &&
        candidate.resourceId.length > 0)) &&
    (flowType !== "employee" || typeof candidate.resourceId === "string") &&
    candidate.returnTo === expectedReturnTo
  );
}

function toBookingCalendarOAuthStateKey(state: string): string {
  return `booking:calendar-oauth-state:${state}`;
}

function assertOAuthState(state: string): void {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(state)) {
    throw new Error("Invalid booking calendar OAuth state");
  }
}

function assertOAuthStatePayload(payload: BookingCalendarOAuthState): void {
  if (!isBookingCalendarOAuthState(payload)) {
    throw new Error("Invalid booking calendar OAuth state payload");
  }
}
