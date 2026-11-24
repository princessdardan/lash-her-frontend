import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.env.NODE_ENV, "test");
assert.equal(process.env.DATABASE_TARGET, "test");
assert.equal(process.env.DOTENV_CONFIG_PATH, "/dev/null");
const url = new URL(process.env.TEST_DATABASE_URL);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.pathname, "/lash_community_course_test");
assert.equal(url.search, "?sslmode=disable");
const secret = process.env.COMMUNITY_ENROLLMENT_PUBLISHER_JWT_CURRENT_SECRET;
assert.match(secret ?? "", /^synthetic-community-[a-z-]{32,}$/u);
const load = (path) => import(pathToFileURL(resolve("src", path + ".ts")).href);
const [
  { createDatabaseConnection },
  { createCommunityEnrollmentPublisher },
  { createDrizzleCommunityEnrollmentPublisherRepository },
  { createCommunityHttpTransport },
] = await Promise.all([
  load("db/client"),
  load("integrations/community/publisher/community-publisher"),
  load("integrations/community/persistence/drizzle-publisher.repository"),
  load("integrations/community/http-transport/community-http-transport"),
]);
const db = createDatabaseConnection(url.href);
try {
  const count = await createCommunityEnrollmentPublisher({
    repository: createDrizzleCommunityEnrollmentPublisherRepository(db.db),
    transport: createCommunityHttpTransport({
      endpoint: "http://127.0.0.1:4108/v1/internal/course/enrollment-events",
      currentSecret: secret,
    }),
  }).runOnce();
  console.log(`Course publisher processed ${count} isolated events.`);
} finally {
  await db.close();
}
