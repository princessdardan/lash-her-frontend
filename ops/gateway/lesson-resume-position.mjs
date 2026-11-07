export const RESTORE_LESSON_STARTED = '{"event":"lesson_started","expectedProgressRevision":4}';

/** @param {string} body */
function parseLessonPosition(body) {
  if (body.length > 128) return null;
  try {
    const { resumePositionSeconds, maxPositionSeconds, expectedProgressRevision } = JSON.parse(body);
    if (!Number.isSafeInteger(resumePositionSeconds) || !Number.isSafeInteger(maxPositionSeconds) ||
        body !== JSON.stringify({ resumePositionSeconds, maxPositionSeconds, expectedProgressRevision })) return null;
    return { resumePositionSeconds, maxPositionSeconds, expectedProgressRevision };
  } catch {
    return null;
  }
}

/** Parse one of the three reviewed native progress writes without trusting JSON coercion.
 * @param {string} body
 */
export function parseLessonResumePosition(body) {
  const position = parseLessonPosition(body);
  if (!position) return null;
  const { resumePositionSeconds: resume, maxPositionSeconds: maximum, expectedProgressRevision } = position;
  const heartbeat = expectedProgressRevision === 1 && resume >= 10 && resume <= 12 && maximum === resume;
  const pause = expectedProgressRevision === 2 && resume >= 13 && resume <= 16 && maximum <= resume && maximum >= resume - 1;
  const rewind = expectedProgressRevision === 3 && resume >= 3 && resume <= 6 && maximum >= 13 && maximum <= 16;
  return heartbeat || pause || rewind ? position : null;
}

/** @param {number} resumePositionSeconds @param {number} maxPositionSeconds */
export function lessonRestorePositionBody(resumePositionSeconds, maxPositionSeconds) {
  return JSON.stringify({ resumePositionSeconds, maxPositionSeconds, expectedProgressRevision: 5 });
}

/** @param {string} body */
export function parseLessonRestorePosition(body) {
  const position = parseLessonPosition(body);
  if (!position) return null;
  const { resumePositionSeconds: resume, maxPositionSeconds: maximum, expectedProgressRevision } = position;
  return expectedProgressRevision === 5 && resume >= 3 && resume <= 6 && maximum === resume + 10 ? position : null;
}
