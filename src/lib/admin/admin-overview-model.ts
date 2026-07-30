import type { AdminActor } from "./types";

export type AdminOverviewResourceScope =
  | { kind: "all" }
  | { ids: readonly string[]; kind: "assigned" }
  | { kind: "none" };

export interface AdminOverviewSectionFailure<
  Key extends PropertyKey = PropertyKey,
> {
  error: unknown;
  key: Key;
}

export interface AdminOverviewAttentionAccess {
  bookingIssuesHref: "/admin/booking-issues" | null;
  calendarHref: "/admin/calendar-connections" | "/admin/my-calendar";
}

export function getAdminOverviewResourceScope(
  actor: AdminActor,
): AdminOverviewResourceScope {
  if (actor.user.role !== "employee") {
    return { kind: "all" };
  }

  if (actor.bookingResourceIds.length === 0) {
    return { kind: "none" };
  }

  return {
    ids: [...new Set(actor.bookingResourceIds)],
    kind: "assigned",
  };
}

export function getAdminOverviewAttentionAccess(
  scope: AdminOverviewResourceScope,
): AdminOverviewAttentionAccess {
  if (scope.kind === "all") {
    return {
      bookingIssuesHref: "/admin/booking-issues",
      calendarHref: "/admin/calendar-connections",
    };
  }

  return {
    bookingIssuesHref: null,
    calendarHref: "/admin/my-calendar",
  };
}

export async function settleAdminOverviewSections<
  Loaders extends Record<string, () => Promise<unknown>>,
>(
  loaders: Loaders,
): Promise<{
  failures: AdminOverviewSectionFailure<keyof Loaders>[];
  values: {
    [Key in keyof Loaders]: Awaited<ReturnType<Loaders[Key]>> | null;
  };
}> {
  const entries = Object.entries(loaders) as Array<
    [keyof Loaders, Loaders[keyof Loaders]]
  >;
  const results = await Promise.allSettled(entries.map(([, load]) => load()));
  const failures: AdminOverviewSectionFailure<keyof Loaders>[] = [];
  const values = {} as {
    [Key in keyof Loaders]: Awaited<ReturnType<Loaders[Key]>> | null;
  };

  entries.forEach(([key], index) => {
    const result = results[index]!;
    if (result.status === "fulfilled") {
      values[key] = result.value as Awaited<ReturnType<Loaders[typeof key]>>;
      return;
    }

    values[key] = null;
    failures.push({ error: result.reason, key });
  });

  return { failures, values };
}
