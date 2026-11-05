// A rejected sibling must not let an admitted booking operation settle while
// another Calendar request, notification or transaction query is still running.
export async function awaitBookingEffects<T extends readonly unknown[]>(
  effects: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const results = await Promise.allSettled(effects);
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  }) as { -readonly [K in keyof T]: Awaited<T[K]> };
}
