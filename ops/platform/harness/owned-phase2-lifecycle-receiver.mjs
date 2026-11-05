// Private owned-harness process. Its control channel is IPC, not an API route.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
let app, pool, lifecycle, clock = 0;
async function initialize(input) {
  assert.ok(input.root.startsWith("/private/") || input.root.startsWith("/var/"));
  assert.equal(input.database.host, "127.0.0.1"); assert.match(input.database.database, /^owned_lifecycle_(course|community)_test$/u);
  clock = input.clock;
  const load = file => import(pathToFileURL(join(input.root, file)).href);
  const require = createRequire(join(input.root, "package.json"));
  const { Pool } = require("pg"), { drizzle } = require("drizzle-orm/node-postgres");
  const schema = await load("src/db/schema.ts");
  pool = new Pool({ ...input.database, ssl: { rejectUnauthorized: true, ca: input.ca }, enableChannelBinding: true, max: 5 });
  const db = drizzle(pool, { schema });
  lifecycle = (await load("src/accounts/lifecycle-repository.ts")).createAccountLifecycleRepository(db, () => new Date(clock));
  const buildApp = (await load("src/app.ts")).buildApp;
  const auth = (await load("src/accounts/lifecycle-auth.ts")).createAccountLifecycleVerifier;
  const serviceKey = input.keys[`${input.service.toUpperCase()}_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET`];
  const lifecycleOptions = { repository: lifecycle, authVerifier: auth({ currentSecret: serviceKey, nowSeconds: () => Math.floor(clock / 1000) }) };
  if (input.service === "course") {
    const firstParty = (await load("src/auth/first-party.ts")).createFirstPartyJwtVerifier;
    const course = (await load("src/courses/course.repository.ts")).createDrizzleCourseRepository(db);
    const entitlement = (await load("src/video/video.repository.ts")).createDrizzleEntitlementRepository(db);
    app = await buildApp({ authVerifier: firstParty({ learner: { currentSecret: input.keys.COURSE_LEARNER_JWT_CURRENT_SECRET }, admin: { currentSecret: input.keys.COURSE_ADMIN_JWT_CURRENT_SECRET }, nowSeconds: () => Math.floor(clock / 1000) }), accountAccessReader: lifecycle,
      accountLifecycle: { ...lifecycleOptions, rateLimit: { maxPerMinute: 1000, burst: 1000 }, networkPolicy: (await load("src/entitlements/internal-network.ts")).createInternalNetworkPolicy({ allowedIps: ["127.0.0.1/32"] }) },
      courseRepository: course, entitlementRepository: entitlement,
      freeEnrollmentRepository: (await load("src/entitlements/free-enrollment.repository.ts")).createDrizzleFreeEnrollmentRepository(db),
      quizRepository: (await load("src/quizzes/drizzle-quiz.repository.ts")).createDrizzleQuizRepository(db),
      lessonProgressRepository: (await load("src/progress/lesson-progress.repository.ts")).createDrizzleLessonProgressRepository(db),
    });
  } else {
    const verify = (await load("src/auth/community-user-auth.ts")).createCommunityUserVerifier;
    const receiver = await load("src/integrations/course/receiver/course-enrollment-receiver.routes.ts");
    const publisher = await load("src/integrations/course/receiver/course-publisher-auth.ts");
    app = await buildApp({ accountAccess: lifecycle, accountLifecycle: lifecycleOptions,
      communityUserVerifier: verify({ member: { currentSecret: input.keys.COMMUNITY_MEMBER_JWT_CURRENT_SECRET }, nowSeconds: () => Math.floor(clock / 1000) }),
      integrationRoutes: receiver.createCourseEnrollmentReceiverRoutes({ authVerifier: publisher.createCoursePublisherVerifier({ currentSecret: input.keys.COURSE_PUBLISHER_JWT_CURRENT_SECRET, nowSeconds: () => Math.floor(clock / 1000) }),
        networkPolicy: (await load("src/integrations/course/receiver/course-publisher-network.ts")).createCoursePublisherAddressPolicy(["127.0.0.1/32"]),
        repository: (await load("src/integrations/course/inbox/course-enrollment-receipt.repository.ts")).createDrizzleCourseEnrollmentReceiptRepository(db), now: () => new Date(clock) }),
    });
    // Community member product features are out of scope. This fixture route
    // exercises its actual published member guard and account-state boundary.
    app.get("/owned/member", { config: { communityAuth: "member" } }, async request => ({ userId: request.communityPrincipal.claims.sub }));
  }
  await app.listen({ host: "127.0.0.1", port: 0 });
  return { host: "127.0.0.1", port: app.server.address().port };
}
process.on("message", async input => {
  try {
    if (input.op === "stop") { await app?.close(); await pool?.end(); process.send?.({ id: input.id, result: { stopped: true } }); process.disconnect(); return; }
    const result = input.op === "initialize" ? await initialize(input) : input.op === "clock" ? (clock = input.clock, { accepted: true }) : input.op === "cleanup" ? { expired: await lifecycle.deleteExpiredExports() } : (() => { throw new Error("Unknown owned operation"); })();
    process.send?.({ id: input.id, result });
  } catch (error) { process.send?.({ id: input.id, error: error instanceof Error ? error.message.slice(0, 200) : "Owned receiver failure" }); }
});
