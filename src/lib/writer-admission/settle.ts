// Unlike Promise.all, retain the operation until every started sibling settles.
export async function settleWriterEffects<T extends readonly unknown[]>(
  tasks: T | [],
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const results = await Promise.allSettled(tasks);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results.map(
    (result) => (result as PromiseFulfilledResult<unknown>).value,
  ) as { -readonly [K in keyof T]: Awaited<T[K]> };
}
