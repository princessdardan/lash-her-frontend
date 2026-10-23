import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { closePrivateDbPool, getPrivateDb } from "@/lib/private-db/client";
import { retainHighLevelRecords } from "./retention";

test(
  "HighLevel retention applies timestamp cutoffs, preserves active work and requeues expired consent once",
  {
    skip: process.env.TEST_DATABASE_URL ? false : "TEST_DATABASE_URL required",
  },
  async () => {
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `retention_${randomUUID().replaceAll("-", "")}`;
    const previousUrl = process.env.DATABASE_URL;
    // Isolate the destructive sweep from every other DB test's records. Copy the
    // migrated table definitions, including their indexes and check constraints.
    const tables = [
      "highlevel_oauth_states",
      "highlevel_webhook_receipts",
      "highlevel_outbox",
      "highlevel_contacts",
      "highlevel_consent_events",
    ];
    try {
      await admin.query(`create schema ${schema}`);
      for (const table of tables) {
        await admin.query(
          `create table ${schema}.${table} (like public.${table} including all)`,
        );
      }
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.searchParams.set(
        "options",
        `-c search_path=${schema} -c timezone=America/Toronto`,
      );
      process.env.DATABASE_URL = url.toString();
      const db = getPrivateDb();
      const now = new Date("2026-10-22T23:00:00.000Z");
      await db.execute(sql`insert into highlevel_oauth_states (hash, actor_id, expires_at) values
      ('expired', gen_random_uuid(), ${now}::timestamptz - interval '1 millisecond'),
      ('boundary', gen_random_uuid(), ${now}::timestamptz),
      ('recent', gen_random_uuid(), ${now}::timestamptz + interval '1 millisecond')`);
      await db.execute(sql`insert into highlevel_webhook_receipts (key, location_id, event_type, received_at)
      select label, 'test', 'test', ${now}::timestamptz - interval '90 days' + delta
      from (values ('expired', interval '-1 millisecond'), ('boundary', interval '0'), ('recent', interval '1 millisecond')) f(label, delta)`);
      await db.execute(sql`insert into highlevel_outbox (event_key, entity_type, entity_id, event_type, status, completed_at)
      select status || ':' || label, 'test', 'test', 'test', status, ${now}::timestamptz - interval '395 days' + delta
      from (values ('succeeded'), ('skipped'), ('queued'), ('processing'), ('retry'), ('review'), ('dead_letter')) s(status)
      cross join (values ('expired', interval '-1 millisecond'), ('boundary', interval '0'), ('recent', interval '1 millisecond'), ('null', null::interval)) f(label, delta)`);
      await db.execute(sql`insert into highlevel_contacts (location_id, email_normalized, deleted_at) values
      ('test', 'expired@example.test', null), ('test', 'boundary@example.test', null),
      ('test', 'recent@example.test', null), ('test', 'deleted@example.test', ${now}::timestamptz)`);
      await db.execute(sql`insert into highlevel_consent_events (origin_key, email_normalized, channel, destination, choice, source, occurred_at)
      select label, label || '@example.test', 'email', label || '@example.test', 'opted_in', 'test',
        ${now}::timestamptz - interval '2555 days' + delta
      from (values ('expired', interval '-1 millisecond'), ('boundary', interval '0'), ('recent', interval '1 millisecond'), ('deleted', interval '-1 millisecond')) f(label, delta)`);

      assert.equal(await retainHighLevelRecords(now), 6);
      assert.deepEqual(
        (
          await db.execute(
            sql`select hash from highlevel_oauth_states order by hash`,
          )
        ).rows.map((r) => r.hash),
        ["boundary", "recent"],
      );
      assert.deepEqual(
        (
          await db.execute(
            sql`select key from highlevel_webhook_receipts order by key`,
          )
        ).rows.map((r) => r.key),
        ["boundary", "recent"],
      );
      assert.deepEqual(
        (
          await db.execute(
            sql`select origin_key from highlevel_consent_events order by origin_key`,
          )
        ).rows.map((r) => r.origin_key),
        ["boundary", "recent"],
      );
      const jobs = (
        await db.execute(
          sql`select event_key from highlevel_outbox where entity_type = 'test' order by event_key`,
        )
      ).rows.map((r) => r.event_key);
      assert.equal(jobs.length, 26);
      for (const status of [
        "queued",
        "processing",
        "retry",
        "review",
        "dead_letter",
      ])
        assert.ok(jobs.includes(`${status}:expired`));
      assert.ok(!jobs.includes("succeeded:expired"));
      assert.ok(!jobs.includes("skipped:expired"));
      const consentJobs = (
        await db.execute(
          sql`select * from highlevel_outbox where event_type = 'consent_retention_expired'`,
        )
      ).rows;
      assert.equal(consentJobs.length, 1);
      const contact = (
        await db.execute(
          sql`select id from highlevel_contacts where email_normalized = 'expired@example.test'`,
        )
      ).rows[0];
      assert.equal(consentJobs[0].entity_id, contact.id);
      assert.equal(
        consentJobs[0].event_key,
        `consent-expiry:${contact.id}:2026-10-22`,
      );
      assert.equal(consentJobs[0].status, "queued");
      assert.equal(await retainHighLevelRecords(now), 0);
      assert.equal(
        (
          await db.execute(
            sql`select * from highlevel_outbox where event_type = 'consent_retention_expired'`,
          )
        ).rows.length,
        1,
      );
    } finally {
      await closePrivateDbPool();
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
    }
  },
);
