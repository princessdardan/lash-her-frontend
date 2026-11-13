/**
 * Read only the storage entry selected by the legacy course grant.
 * The current signed-in account and enrollment are checked by Course.
 */
export function legacyPracticeProgress(
  raw: string | null,
  grant: { courseId: string; grantId: string; expiresAt: number },
  now = Date.now(),
) {
  if (!raw || raw.length >= 1_000_000 || grant.expiresAt * 1000 <= now) return null;
  const key = /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/u;
  const isKey = (value: unknown): value is string => typeof value === "string" && key.test(value);
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isRecord(value) || value.version !== 1 || value.grantId !== grant.grantId ||
    value.expiresAt !== grant.expiresAt || !isRecord(value.modules) || !isKey(grant.courseId)) return null;
  const entries = Object.entries(value.modules);
  if (entries.length > 30) return null;
  const modules = [];
  for (const [moduleKey, state] of entries) {
    if (!isKey(moduleKey) || !isRecord(state)) continue;
    const position = state.position;
    const video = isKey(state.videoId) && typeof position === "number" && Number.isFinite(position) && position > 0 && position <= 86_400
      ? { id: state.videoId, positionSeconds: Math.floor(position) } : undefined;
    const answers = state.submitted === true && isRecord(state.answers)
      ? Object.entries(state.answers).flatMap(([questionKey, optionKey]) => isKey(questionKey) && isKey(optionKey) ? [{ questionKey, optionKey }] : [])
      : [];
    const submitted = answers.length && answers.length <= 10 ? answers : undefined;
    if (video || submitted) modules.push({ key: moduleKey, ...(video ? { video } : {}), ...(submitted ? { answers: submitted } : {}) });
  }
  return modules.length ? { sourceId: grant.courseId, modules } : null;
}
