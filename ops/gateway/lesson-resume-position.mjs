export const RESTORE_LESSON_STARTED = '{"event":"lesson_started","expectedProgressRevision":4}';
const ACK_LOSS_LESSON_STARTED = [6, 9].map(expectedProgressRevision =>
  JSON.stringify({ event: "lesson_started", expectedProgressRevision }));
export const EXIT_SAVE_LESSON_STARTED = ACK_LOSS_LESSON_STARTED[0];

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

/** @param {number} resumePositionSeconds */
export function lessonAckLossBodies(resumePositionSeconds) {
  const maxPositionSeconds = resumePositionSeconds + 10;
  const position = (resume, expectedProgressRevision) =>
    JSON.stringify({ resumePositionSeconds: resume, maxPositionSeconds, expectedProgressRevision });
  return [
    ACK_LOSS_LESSON_STARTED[0],
    position(resumePositionSeconds, 7),
    position(maxPositionSeconds, 8),
    ACK_LOSS_LESSON_STARTED[1],
    position(maxPositionSeconds, 10),
  ];
}

/** @param {string} body */
export function permitsLessonAckLossBody(body) {
  if (ACK_LOSS_LESSON_STARTED.includes(body)) return true;
  const position = parseLessonPosition(body);
  if (!position) return false;
  const { resumePositionSeconds: resume, maxPositionSeconds: maximum, expectedProgressRevision } = position;
  if (maximum < 13 || maximum > 16) return false;
  return expectedProgressRevision === 7 ? resume === maximum - 10 :
    (expectedProgressRevision === 8 || expectedProgressRevision === 10) && resume === maximum;
}

/** @param {number} resumePositionSeconds */
export function lessonExitSaveBodies(resumePositionSeconds) {
  return [EXIT_SAVE_LESSON_STARTED, lessonAckLossBodies(resumePositionSeconds)[1],
    '{"expectedProgressRevision":8}'];
}

/** @param {string} body */
export function parseLessonExitSavePosition(body) {
  const position = parseLessonPosition(body);
  if (!position) return null;
  const { resumePositionSeconds: resume, maxPositionSeconds: maximum, expectedProgressRevision } = position;
  if (maximum < 13 || maximum > 16) return null;
  const baseline = maximum - 10;
  return (expectedProgressRevision === 7 && resume === baseline) ||
    (expectedProgressRevision === 8 && resume >= baseline + 2 && resume <= baseline + 5) ? position : null;
}
