import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach } from "node:test";
import { eq, sql } from "drizzle-orm";
import { getPrivateDb, closePrivateDbPool } from "@/lib/private-db/client";
import {
  marketingContacts,
  marketingConsentEvents,
  marketingContactSubmissions,
  marketingContactSyncJobs,
} from "@/lib/private-db/schema";
import {
  recordCourseSignupSubmission,
  recordInternalUnsubscribe,
} from "@/lib/marketing-contact/marketing-contact-store";
import { COURSE_CONSENT_TEXT } from "./contract";
import {
  createCourseAccessToken,
  verifyCourseAccessToken,
} from "./access-token";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) process.env.DATABASE_URL = testDatabaseUrl;
const skip = testDatabaseUrl ? undefined : "TEST_DATABASE_URL is required";
const email = `course-${randomUUID()}@example.invalid`;
const signup = {
  email,
  courseId: "course-test",
  courseTitle: "Test course",
  sourcePath: "/courses/test-course",
};

afterEach(async () => {
  if (!testDatabaseUrl) return;
  const db = getPrivateDb();
  await db
    .delete(marketingContactSyncJobs)
    .where(eq(marketingContactSyncJobs.emailNormalized, email));
  await db
    .delete(marketingConsentEvents)
    .where(eq(marketingConsentEvents.emailNormalized, email));
  await db
    .delete(marketingContactSubmissions)
    .where(eq(marketingContactSubmissions.emailNormalized, email));
  await db
    .delete(marketingContacts)
    .where(eq(marketingContacts.emailNormalized, email));
});
after(closePrivateDbPool);

test(
  "course signup persists consent and outbox atomically and deduplicates the contact",
  { skip },
  async () => {
    const db = getPrivateDb();
    const result = await recordCourseSignupSubmission(signup);
    assert.ok(result.syncJobId);
    await recordCourseSignupSubmission({
      ...signup,
      email: email.toUpperCase(),
    });
    const contacts = await db
      .select()
      .from(marketingContacts)
      .where(eq(marketingContacts.emailNormalized, email));
    const submissions = await db
      .select()
      .from(marketingContactSubmissions)
      .where(eq(marketingContactSubmissions.emailNormalized, email));
    const events = await db
      .select()
      .from(marketingConsentEvents)
      .where(eq(marketingConsentEvents.emailNormalized, email));
    const jobs = await db
      .select()
      .from(marketingContactSyncJobs)
      .where(eq(marketingContactSyncJobs.emailNormalized, email));
    assert.equal(contacts.length, 1);
    assert.equal(submissions.length, 2);
    assert.equal(events.length, 2);
    assert.equal(jobs.length, 2);
    assert.equal(submissions[0].submissionType, "course_signup");
    assert.equal(submissions[0].consentText, COURSE_CONSENT_TEXT);
    assert.deepEqual(submissions[0].payload, {
      courseId: signup.courseId,
      courseTitle: signup.courseTitle,
    });
    assert.ok(
      events.every(
        (event) =>
          event.contactId === contacts[0].id && event.eventType === "opt_in",
      ),
    );
    assert.ok(
      jobs.every(
        (job) => job.status === "queued" && job.source === "course_signup",
      ),
    );

    const secret = "test-course-secret-012345678901234567890123456789";
    const { token } = createCourseAccessToken(signup.courseId, secret);
    await recordInternalUnsubscribe({ email, reason: "course-test" });
    assert.ok(verifyCourseAccessToken(token, signup.courseId, secret));
    const [contact] = await db
      .select()
      .from(marketingContacts)
      .where(eq(marketingContacts.emailNormalized, email));
    assert.ok(contact.unsubscribedAt);
  },
);

test(
  "failure inserting the sync job rolls back contact, submission and consent",
  { skip },
  async () => {
    const db = getPrivateDb();
    const name = `course_failure_${randomUUID().replaceAll("-", "")}`;
    // A trigger limited to this test address injects a failure at the final write.
    await db.execute(
      sql.raw(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.email_normalized = '${email}' THEN RAISE EXCEPTION 'course test rollback'; END IF; RETURN NEW; END $$`,
      ),
    );
    try {
      await db.execute(
        sql.raw(
          `CREATE TRIGGER ${name} BEFORE INSERT ON marketing_contact_sync_jobs FOR EACH ROW EXECUTE FUNCTION ${name}()`,
        ),
      );
      await assert.rejects(recordCourseSignupSubmission(signup));
      assert.equal(
        (
          await db
            .select()
            .from(marketingContacts)
            .where(eq(marketingContacts.emailNormalized, email))
        ).length,
        0,
      );
      assert.equal(
        (
          await db
            .select()
            .from(marketingContactSubmissions)
            .where(eq(marketingContactSubmissions.emailNormalized, email))
        ).length,
        0,
      );
      assert.equal(
        (
          await db
            .select()
            .from(marketingConsentEvents)
            .where(eq(marketingConsentEvents.emailNormalized, email))
        ).length,
        0,
      );
    } finally {
      await db.execute(
        sql.raw(
          `DROP TRIGGER IF EXISTS ${name} ON marketing_contact_sync_jobs`,
        ),
      );
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${name}()`));
    }
  },
);
