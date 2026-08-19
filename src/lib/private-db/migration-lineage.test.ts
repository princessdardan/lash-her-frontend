import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAppliedMigrationLineage,
  buildExpectedPrivateDbMigrationLineage,
  type ExpectedMigrationLineageEntry,
} from "./migration-lineage";

const migrations: ExpectedMigrationLineageEntry[] = [
  { folderMillis: 100, hash: "hash-100", tag: "0000_first" },
  { folderMillis: 200, hash: "hash-200", tag: "0001_second" },
  { folderMillis: 300, hash: "hash-300", tag: "0002_third" },
];

test("accepts an empty journal and an exact applied prefix", () => {
  assert.equal(assertAppliedMigrationLineage(migrations, []), 0);
  assert.equal(
    assertAppliedMigrationLineage(migrations, [
      { created_at: "100", hash: "hash-100" },
      { created_at: "200", hash: "hash-200" },
    ]),
    200,
  );
});

test("rejects an applied timestamp whose stored hash differs", () => {
  assert.throws(
    () =>
      assertAppliedMigrationLineage(migrations, [
        { created_at: "100", hash: "different-deployed-hash" },
      ]),
    /Migration lineage mismatch for 0000_first \(100\): database hash different-deployed-hash does not match local hash hash-100/,
  );
});

test("accepts only the audited abandoned-branch entries and reconciled 0016 hash", () => {
  const expected = buildExpectedPrivateDbMigrationLineage([
    {
      folderMillis: 1783023767006,
      hash: "7698d4d5cedf4205a3484575be6f01db8ebc4a3f3e4dc434b1a58010d7a26d2c",
      tag: "0016_bitter_yellow_claw",
    },
  ]);

  assert.equal(
    assertAppliedMigrationLineage(expected, [
      {
        created_at: "1780454716621",
        hash: "5610ea67c054201218507dc5aecf55f8c42af8ff465ada2b846bbef194de6a75",
      },
      {
        created_at: "1780520000000",
        hash: "9ed678e8cfdb74df5dfe7da13692d7b258c17237015de191310b7d8b0c916b79",
      },
      {
        created_at: "1783023767006",
        hash: "223b503a8609f1f3451550a6ce9c133b89fe501b206dd147731d36f295fc09f3",
      },
    ]),
    1783023767006,
  );

  assert.equal(
    assertAppliedMigrationLineage(expected, [
      {
        created_at: "1783023767006",
        hash: "7698d4d5cedf4205a3484575be6f01db8ebc4a3f3e4dc434b1a58010d7a26d2c",
      },
    ]),
    1783023767006,
    "optional abandoned-branch entries must not create gaps on clean databases",
  );

  assert.throws(
    () =>
      assertAppliedMigrationLineage(expected, [
        {
          created_at: "1780454716621",
          hash: "unrecognized-legacy-hash",
        },
      ]),
    /Migration lineage mismatch for legacy\/0011_red_rocket_raccoon/,
  );
});

test("rejects edits to a migration that has an accepted historical hash", () => {
  assert.throws(
    () =>
      buildExpectedPrivateDbMigrationLineage([
        {
          folderMillis: 1783023767006,
          hash: "edited-local-hash",
          tag: "0016_bitter_yellow_claw",
        },
      ]),
    /no longer matches its canonical reconciled hash/,
  );
});

test("rejects unknown, duplicate, invalid, and gapped applied timestamps", () => {
  assert.throws(
    () =>
      assertAppliedMigrationLineage(migrations, [
        { created_at: "999", hash: "unknown" },
      ]),
    /unknown timestamp 999/,
  );
  assert.throws(
    () =>
      assertAppliedMigrationLineage(migrations, [
        { created_at: "100", hash: "hash-100" },
        { created_at: 100, hash: "hash-100" },
      ]),
    /duplicate timestamp 100/,
  );
  assert.throws(
    () =>
      assertAppliedMigrationLineage(migrations, [
        { created_at: null, hash: "hash-100" },
      ]),
    /invalid timestamp null/,
  );
  assert.throws(
    () =>
      assertAppliedMigrationLineage(migrations, [
        { created_at: "100", hash: "hash-100" },
        { created_at: "300", hash: "hash-300" },
      ]),
    /lineage has a gap at 0001_second \(200\)/,
  );
});
