// Only local token signing is permitted. Asset/media rows are owned fixtures;
// no Mux, Google, Resend or other provider HTTP operation may leave this server.
"use strict";
if (process.env.COURSE_LEARNING_BROWSER_FIXTURE === "1") {
  const database = new URL(process.env.TEST_DATABASE_URL || "");
  if (
    process.env.NODE_ENV !== "test" ||
    database.hostname !== "127.0.0.1" ||
    database.pathname !== "/lash_learning_course_integration"
  )
    throw new Error("Course learner fixture requires its owned database");
  globalThis.fetch = async () => {
    throw new Error("Unexpected provider HTTP in owned Course learner fixture");
  };
}
