import assert from "node:assert/strict";
import test from "node:test";

import { withWriterOperationContext } from "@/lib/writer-admission/context";
import {
  consumeBookingCalendarOAuthState,
  isBookingCalendarOAuthState,
  saveBookingCalendarOAuthState,
  type BookingCalendarOAuthStateStorage,
} from "./calendar-oauth-state";
import { writeGoogleRefreshToken } from "./google-refresh-token-store";

test("calendar OAuth state is actor/resource bound, fixed-path, expiring, and one-time", async () => {
  let nowSeconds = 1_000;
  const values = new Map<string, { expiresAt: number; value: string }>();
  const storage = {
    async set(key: string, value: unknown, options: { ex: number; nx: true }) {
      if (values.has(key)) return null;
      values.set(key, {
        expiresAt: nowSeconds + options.ex,
        value: String(value),
      });
      return "OK";
    },
    async eval<TResult>(_script: string, keys: string[]): Promise<TResult> {
      const key = keys[0]!;
      const stored = values.get(key);
      values.delete(key);
      if (!stored || stored.expiresAt <= nowSeconds) {
        return [0] as TResult;
      }
      return [1, stored.value] as TResult;
    },
  } as unknown as BookingCalendarOAuthStateStorage;
  const payload = {
    actorAdminUserId: "employee-1",
    connectionId: "connection-1",
    flowType: "employee" as const,
    resourceId: "resource-1",
    returnTo: "/admin/my-calendar",
  };
  const state = "calendar_abcdefghijklmnopqrstuvwxyz123456";

  assert.equal(
    await saveBookingCalendarOAuthState(
      { payload, state, ttlSeconds: 600 },
      storage,
    ),
    true,
  );
  assert.deepEqual(
    await consumeBookingCalendarOAuthState(state, storage),
    payload,
  );
  assert.equal(await consumeBookingCalendarOAuthState(state, storage), null);

  const expiringState = "calendar_abcdefghijklmnopqrstuvwxyz654321";
  assert.equal(
    await saveBookingCalendarOAuthState(
      { payload, state: expiringState, ttlSeconds: 600 },
      storage,
    ),
    true,
  );
  nowSeconds += 601;
  assert.equal(
    await consumeBookingCalendarOAuthState(expiringState, storage),
    null,
  );
});

test("calendar OAuth state accepts Upstash's automatically deserialized eval result", async () => {
  const payload = {
    actorAdminUserId: "employee-1",
    connectionId: "connection-1",
    flowType: "employee" as const,
    resourceId: "resource-1",
    returnTo: "/admin/my-calendar",
  };
  const storage = {
    async eval<TResult>(): Promise<TResult> {
      return [1, payload] as TResult;
    },
    async set() {
      throw new Error("state storage is not written while consuming");
    },
  } as BookingCalendarOAuthStateStorage;

  assert.deepEqual(
    await consumeBookingCalendarOAuthState(
      "calendar_abcdefghijklmnopqrstuvwxyz123456",
      storage,
    ),
    payload,
  );
});

test("calendar OAuth state distinguishes absent state from malformed consumed evidence", async () => {
  const state = "calendar_abcdefghijklmnopqrstuvwxyz123456";
  const storage = (receipt: unknown): BookingCalendarOAuthStateStorage => ({
    async eval<TArgs extends unknown[], TResult>(
      script: string,
      keys: string[],
      args: TArgs,
    ): Promise<TResult> {
      assert.match(script, /return \{1, value\}/);
      assert.deepEqual(keys, [`booking:calendar-oauth-state:${state}`]);
      assert.deepEqual(args, []);
      return receipt as TResult;
    },
    async set() {
      throw new Error("state storage is not written while consuming");
    },
  });

  assert.equal(await withWriterOperationContext(
    () => consumeBookingCalendarOAuthState(state, storage([0])),
  ), null);
  for (const receipt of [[1, null], [1, "invalid JSON"], [1, { flowType: "admin" }], null]) {
    assert.equal(await consumeBookingCalendarOAuthState(state, storage(receipt)), null);
    await assert.rejects(
      withWriterOperationContext(() => consumeBookingCalendarOAuthState(state, storage(receipt))),
      /WRITER_OPERATION_REQUIRES_REVIEW/,
    );
  }
});

test("legacy Calendar credential persistence requires the exact Redis SET receipt", async () => {
  const environment = { VERCEL_TARGET_ENV: "preview" };
  const refreshToken = "owned-calendar-credential";
  const writes: [string, string][] = [];
  const storage = (receipt: unknown) => ({
    async get<TData>(): Promise<TData | null> {
      assert.fail("write must not read an old credential as evidence");
    },
    async set(key: string, value: string) {
      writes.push([key, value]);
      return receipt;
    },
  });

  await writeGoogleRefreshToken(refreshToken, storage("OK"), environment);
  assert.deepEqual(writes, [["booking:google-refresh-token:preview", refreshToken]]);
  for (const receipt of [null, undefined, true, "ok", { status: "OK" }]) {
    await assert.rejects(
      writeGoogleRefreshToken(refreshToken, storage(receipt), environment),
      /Calendar credential write was not acknowledged/,
    );
  }
});

test("calendar OAuth state rejects unsafe or flow-inconsistent redirects", () => {
  const base = {
    actorAdminUserId: "employee-1",
    connectionId: "connection-1",
    flowType: "employee" as const,
    resourceId: "resource-1",
  };

  assert.equal(
    isBookingCalendarOAuthState({
      ...base,
      returnTo: "//attacker.example/admin/my-calendar",
    }),
    false,
  );
  assert.equal(
    isBookingCalendarOAuthState({
      ...base,
      resourceId: null,
      returnTo: "/admin/my-calendar",
    }),
    false,
  );
  assert.equal(
    isBookingCalendarOAuthState({
      actorAdminUserId: "admin-1",
      connectionId: "connection-1",
      flowType: "admin",
      resourceId: null,
      returnTo: "/admin/calendar-connections",
    }),
    true,
  );
});
