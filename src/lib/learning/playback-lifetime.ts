const maximumLifetimeMs = 600_000;

/** The same-origin response Date avoids trusting a customer's wall clock.
 * Subtract the entire request duration conservatively and never extend the
 * published 600-second authorization lifetime. Missing Date fails back to local
 * time; malformed, expired or already-exhausted authorization is never installed.
 */
export function playbackLifetime(
  expiresAt: string,
  thumbnailExpiresAt: string,
  clock: { serverDate: string | null; localNow: number; elapsedMs: number },
): number {
  const serverNow =
    clock.serverDate === null ? NaN : Date.parse(clock.serverDate);
  // HTTP Date has one-second precision. Use the end of that second so its
  // rounding cannot extend an authorization beyond the actual expiry.
  const reference = Number.isFinite(serverNow)
    ? serverNow + 1000
    : clock.localNow;
  const expiry = Math.min(
    Date.parse(expiresAt),
    Date.parse(thumbnailExpiresAt),
  );
  const duration =
    Math.min(maximumLifetimeMs, expiry - reference) -
    Math.max(0, clock.elapsedMs);
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("Playback authorization is expired or invalid");
  return duration;
}
