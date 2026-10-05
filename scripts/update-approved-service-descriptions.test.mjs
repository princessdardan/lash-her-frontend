import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@sanity/client";

import {
  APPROVED_COPY,
  TARGET,
  buildUpdatePlan,
  getClientConfig,
  parseArgs,
  runUpdate,
  safeErrorMessage,
  saveBackup,
} from "./update-approved-service-descriptions.mjs";

function documents() {
  return APPROVED_COPY.map((entry) => ({
    _id: `service-${entry.slug}`,
    _rev: "revision-1",
    slug: entry.slug,
    title: entry.title,
    image: { asset: { _ref: "keep-this-image" } },
    ...entry.before,
  }));
}

function harness(t, initial = documents()) {
  let store = structuredClone(initial);
  const events = [];
  const client = createClient({
    ...TARGET,
    apiVersion: "2026-03-24",
    useCdn: false,
    token: "fixture-token",
  });
  const mutate = t.mock.method(client, "mutate", async (mutations, options) => {
    events.push("mutate");
    assert.equal(options.visibility, "sync");
    assert.equal(options.returnDocuments, false);
    // Validate all revisions before applying any patch, as Sanity does.
    for (const { patch } of mutations) {
      assert.equal(
        store.find((doc) => doc._id === patch.id)?._rev,
        patch.ifRevisionID,
      );
    }
    for (const { patch } of mutations) {
      const doc = store.find((doc) => doc._id === patch.id);
      Object.assign(doc, patch.set, { _rev: "revision-2" });
    }
    return { transactionId: "fixture-transaction" };
  });
  return {
    client,
    mutate,
    events,
    readDocuments: async () => structuredClone(store),
    replaceStore: (next) => {
      store = next;
    },
    backup: async () => {
      events.push("backup");
      return "/fixture/backup.json";
    },
    log: () => {},
  };
}

test("defaults to a dry run and rejects ambiguous or unknown options", () => {
  assert.deepEqual(parseArgs([]), {
    apply: false,
    help: false,
    backupDir: ".backups",
  });
  assert.equal(parseArgs(["--apply"]).apply, true);
  assert.throws(() => parseArgs(["--apply", "--dry-run"]), /either/);
  assert.throws(() => parseArgs(["--backup-dir"]), /requires a directory/);
  assert.throws(() => parseArgs(["--force"]), /Unknown argument/);
});

test("CLI reaches credential validation without performing a network request", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(
        new URL("./update-approved-service-descriptions.mjs", import.meta.url),
      ),
      "--dry-run",
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        NEXT_PUBLIC_SANITY_PROJECT_ID: TARGET.projectId,
        NEXT_PUBLIC_SANITY_DATASET: TARGET.dataset,
        SANITY_API_READ_TOKEN: "",
        SANITY_WRITE_TOKEN: "",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required to check unpublished edits/);
  assert.doesNotMatch(result.stderr, /failed or could not be confirmed/);
});

test("requires an authenticated production client and write token for apply", () => {
  assert.throws(() => getClientConfig({}, false), /read|READ/);
  assert.throws(
    () => getClientConfig({ SANITY_API_READ_TOKEN: "read" }, true),
    /SANITY_WRITE_TOKEN/,
  );
  assert.throws(
    () =>
      getClientConfig(
        { NEXT_PUBLIC_SANITY_DATASET: "staging", SANITY_WRITE_TOKEN: "write" },
        true,
      ),
    /only targets/,
  );
  assert.throws(
    () =>
      getClientConfig(
        { NEXT_PUBLIC_SANITY_PROJECT_ID: "other", SANITY_WRITE_TOKEN: "write" },
        true,
      ),
    /only targets/,
  );
  assert.equal(
    getClientConfig({ SANITY_API_READ_TOKEN: "read" }, false).token,
    "read",
  );
  assert.equal(
    getClientConfig({ SANITY_WRITE_TOKEN: "write" }, true).dataset,
    "production",
  );
});

test("plans only the approved fields on exactly six services", () => {
  const plan = buildUpdatePlan(documents());
  assert.equal(plan.length, 6);
  assert.equal(plan.flatMap((change) => Object.keys(change.set)).length, 7);
  const fill = plan.find((change) => change.slug === "lash-fill");
  assert.equal(fill.set.shortDescription, fill.set.description);
  assert.deepEqual(plan.find((change) => change.slug === "tooth-gem").before, {
    description: APPROVED_COPY[0].before.description,
  });
});

test("refuses missing, duplicate, or unexpected copy before any changes", () => {
  assert.throws(() => buildUpdatePlan(documents().slice(1)), /found 0/);
  assert.throws(
    () =>
      buildUpdatePlan([
        ...documents(),
        { ...documents()[0], _id: "duplicate" },
      ]),
    /found 2/,
  );
  for (const field of ["description", "shortDescription"]) {
    const rows = documents();
    rows[0][field] = "A newer editorial change";
    assert.throws(() => buildUpdatePlan(rows), /Unreviewed/);
  }
  const revisedManifest = structuredClone(APPROVED_COPY);
  revisedManifest[0].set.title = "Not approved";
  assert.throws(
    () => buildUpdatePlan(documents(), revisedManifest),
    /only update approved/,
  );
});

test("blocks pending drafts/releases even if their slug has changed", () => {
  for (const id of [
    "drafts.service-tooth-gem",
    "versions.release123.service-tooth-gem",
  ]) {
    const rows = documents();
    rows.push({ ...rows[0], _id: id, slug: "renamed-in-draft" });
    assert.throws(() => buildUpdatePlan(rows), /Unpublished draft or release/);
  }
  const rows = documents();
  rows.push({ ...rows[0], _id: "drafts.unrelated", slug: "another-service" });
  assert.equal(buildUpdatePlan(rows).length, 6);
});

test("dry run performs no mutation or backup", async (t) => {
  const fixture = harness(t);
  assert.deepEqual(await runUpdate(fixture), { changed: 6, applied: false });
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.mutate.mock.callCount(), 0);
});

test("apply backs up first and sends one atomic revision-guarded transaction", async (t) => {
  const fixture = harness(t);
  assert.equal((await runUpdate({ ...fixture, apply: true })).applied, true);
  assert.deepEqual(fixture.events, ["backup", "mutate"]);
  assert.equal(fixture.mutate.mock.callCount(), 1);
  const mutations = fixture.mutate.mock.calls[0].arguments[0];
  assert.equal(mutations.length, 6);
  for (const mutation of mutations) {
    assert.deepEqual(Object.keys(mutation), ["patch"]);
    assert.equal(mutation.patch.ifRevisionID, "revision-1");
    assert.deepEqual(Object.keys(mutation.patch).sort(), [
      "id",
      "ifRevisionID",
      "set",
    ]);
  }
  for (const doc of await fixture.readDocuments()) {
    assert.deepEqual(doc.image, { asset: { _ref: "keep-this-image" } });
    assert.equal(
      doc.title,
      APPROVED_COPY.find((entry) => entry.slug === doc.slug).title,
    );
  }
  assert.deepEqual(await runUpdate({ ...fixture, apply: true }), {
    changed: 0,
    applied: false,
  });
  assert.equal(fixture.mutate.mock.callCount(), 1);
});

test("already-approved fields are preserved while remaining fields are updated", () => {
  const rows = documents();
  const fill = rows.find((doc) => doc.slug === "lash-fill");
  fill.description = APPROVED_COPY.find(
    (entry) => entry.slug === "lash-fill",
  ).set.description;
  assert.deepEqual(
    Object.keys(
      buildUpdatePlan(rows).find((change) => change.slug === "lash-fill").set,
    ),
    ["shortDescription"],
  );
});

test("backup failure prevents writes", async (t) => {
  const fixture = harness(t);
  await assert.rejects(
    runUpdate({
      ...fixture,
      apply: true,
      backup: async () => {
        throw new Error("disk full");
      },
    }),
    /disk full/,
  );
  assert.equal(fixture.mutate.mock.callCount(), 0);
});

test("revision conflicts cannot partially update the six services", async (t) => {
  const fixture = harness(t);
  await assert.rejects(
    runUpdate({
      ...fixture,
      apply: true,
      backup: async () => {
        const concurrentlyEdited = documents();
        concurrentlyEdited[5]._rev = "newer-revision";
        fixture.replaceStore(concurrentlyEdited);
        return "/fixture/backup.json";
      },
    }),
  );
  const remaining = await fixture.readDocuments();
  assert.deepEqual(
    remaining.map((doc) => doc.description),
    documents().map((doc) => doc.description),
  );
});

test("verification detects an update that was not reflected in stored copy", async (t) => {
  const fixture = harness(t);
  t.mock.method(fixture.client, "mutate", async () => ({
    transactionId: "fixture",
  }));
  await assert.rejects(
    runUpdate({ ...fixture, apply: true }),
    /could not be verified/,
  );
});

test("backup records exact old/new fields without credentials", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "lash-her-copy-test-"),
  );
  try {
    const plan = buildUpdatePlan(documents());
    const filename = await saveBackup(plan, directory);
    const content = JSON.parse(await readFile(filename, "utf8"));
    assert.equal(content.projectId, TARGET.projectId);
    assert.equal(content.dataset, "production");
    assert.deepEqual(content.changes, plan);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(content), /token/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unexpected upstream error messages never expose a token", () => {
  assert.doesNotMatch(
    safeErrorMessage(new Error("Authorization: Bearer secret-token")),
    /secret-token/,
  );
});
