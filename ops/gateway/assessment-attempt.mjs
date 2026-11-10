const answerId = /^(?=.{1,128}$)[A-Za-z0-9_-][A-Za-z0-9_.:-]*$/u;
const attemptId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const maxBody = 32 * 1024;

/**
 * Parse the exact assessment form wire format. Keep the browser UUID out of
 * the reviewed template while the gateway proof still signs the entire body.
 * @param {string} body
 */
export function parseAssessmentAttempt(body) {
  if (body.length > maxBody) return null;
  try {
    const { quizRevision, requestId, answers } = JSON.parse(body);
    if (!Number.isSafeInteger(quizRevision) || quizRevision < 1 || quizRevision > 2_147_483_647 ||
        typeof requestId !== "string" || !attemptId.test(requestId) ||
        !Array.isArray(answers) || answers.length < 1 || answers.length > 100) return null;
    const ordered = [], questions = new Set();
    for (const { questionId, optionId } of answers) {
      if (typeof questionId !== "string" || typeof optionId !== "string" ||
          !answerId.test(questionId) || !answerId.test(optionId) || questions.has(questionId)) return null;
      questions.add(questionId);
      ordered.push({ questionId, optionId });
    }
    if (body !== JSON.stringify({ quizRevision, requestId, answers: ordered })) return null;
    return { quizRevision, requestId, template: JSON.stringify({ quizRevision, answers: ordered }) };
  } catch {
    return null;
  }
}
