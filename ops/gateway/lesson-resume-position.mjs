/** Parse one of the three reviewed native progress writes without trusting JSON coercion.
 * @param {string} body
 */
export function parseLessonResumePosition(body) {
  if (body.length > 128) return null;
  try {
    const { resumePositionSeconds, maxPositionSeconds, expectedProgressRevision } = JSON.parse(body);
    if (!Number.isSafeInteger(resumePositionSeconds) || !Number.isSafeInteger(maxPositionSeconds) ||
        body !== JSON.stringify({ resumePositionSeconds, maxPositionSeconds, expectedProgressRevision })) return null;
    const resume = resumePositionSeconds, maximum = maxPositionSeconds;
    const heartbeat = expectedProgressRevision === 1 && resume >= 10 && resume <= 12 && maximum === resume;
    const pause = expectedProgressRevision === 2 && resume >= 13 && resume <= 16 && maximum <= resume && maximum >= resume - 1;
    const rewind = expectedProgressRevision === 3 && resume >= 3 && resume <= 6 && maximum >= 13 && maximum <= 16;
    if (!heartbeat && !pause && !rewind) return null;
    return { resumePositionSeconds, maxPositionSeconds, expectedProgressRevision };
  } catch {
    return null;
  }
}
