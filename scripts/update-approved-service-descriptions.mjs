import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";

export const TARGET = Object.freeze({
  projectId: "3auncj84",
  dataset: "production",
});
export const APPROVED_COPY = JSON.parse(
  readFileSync(
    new URL("./approved-service-descriptions.json", import.meta.url),
    "utf8",
  ),
);
const TARGET_SLUGS = [
  "tooth-gem",
  "lash-fill",
  "mini-fill",
  "brow-waxing",
  "mobile-appointment",
  "full-set",
];
const COPY_FIELDS = ["description", "shortDescription"];

export class CopyUpdateError extends Error {}

export function parseArgs(args) {
  const options = { apply: false, help: false, backupDir: ".backups" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") continue;
    else if (arg === "--backup-dir") {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new CopyUpdateError("--backup-dir requires a directory.");
      options.backupDir = value;
    } else throw new CopyUpdateError("Unknown argument. Use --help for usage.");
  }
  if (options.apply && args.includes("--dry-run")) {
    throw new CopyUpdateError("Choose either --apply or --dry-run.");
  }
  return options;
}

export function assertTarget(config) {
  if (
    config.projectId !== TARGET.projectId ||
    config.dataset !== TARGET.dataset
  ) {
    throw new CopyUpdateError(
      "This script only targets Sanity project 3auncj84, dataset production.",
    );
  }
}

export function getClientConfig(env, apply) {
  assertTarget({
    projectId: env.NEXT_PUBLIC_SANITY_PROJECT_ID || TARGET.projectId,
    dataset: env.NEXT_PUBLIC_SANITY_DATASET || TARGET.dataset,
  });
  const token = apply
    ? env.SANITY_WRITE_TOKEN
    : env.SANITY_API_READ_TOKEN || env.SANITY_WRITE_TOKEN;
  if (!token?.trim()) {
    throw new CopyUpdateError(
      apply
        ? "SANITY_WRITE_TOKEN is required for --apply."
        : "SANITY_API_READ_TOKEN or SANITY_WRITE_TOKEN is required to check unpublished edits during a dry run.",
    );
  }
  return {
    ...TARGET,
    apiVersion: "2026-03-24",
    token,
    useCdn: false,
    perspective: "raw",
    maxRetries: 0,
  };
}

function isUnpublished(id) {
  return id.startsWith("drafts.") || id.startsWith("versions.");
}

export function buildUpdatePlan(documents, approved = APPROVED_COPY) {
  if (
    approved.length !== TARGET_SLUGS.length ||
    new Set(approved.map((entry) => entry.slug)).size !== TARGET_SLUGS.length ||
    approved.some((entry) => !TARGET_SLUGS.includes(entry.slug))
  )
    throw new CopyUpdateError(
      "The approved manifest must contain exactly the six approved services.",
    );

  const plan = [];
  for (const entry of approved) {
    const fields = Object.keys(entry.set);
    if (
      !fields.includes("description") ||
      fields.some(
        (field) =>
          !COPY_FIELDS.includes(field) ||
          (field === "shortDescription" && entry.slug !== "lash-fill") ||
          typeof entry.set[field] !== "string" ||
          !entry.set[field].trim(),
      ) ||
      (entry.slug === "lash-fill" &&
        entry.set.shortDescription !== entry.set.description)
    )
      throw new CopyUpdateError(
        "The manifest may only update approved description fields.",
      );

    const matches = documents.filter(
      (doc) => !isUnpublished(doc._id) && doc.slug === entry.slug,
    );
    if (matches.length !== 1) {
      throw new CopyUpdateError(
        `Expected one published service for ${entry.slug}; found ${matches.length}.`,
      );
    }
    const doc = matches[0];
    if (!doc._rev)
      throw new CopyUpdateError(`Missing revision for ${entry.slug}.`);

    const pending = documents.some(
      (other) =>
        isUnpublished(other._id) &&
        (other.slug === entry.slug ||
          other._id === `drafts.${doc._id}` ||
          other._id.replace(/^versions\.[^.]+\./, "") === doc._id),
    );
    if (pending)
      throw new CopyUpdateError(
        `Unpublished draft or release exists for ${entry.slug}; resolve it before updating published copy.`,
      );

    // Accept only the reviewed original copy or the exact approved replacement.
    // This also makes re-runs and already-applied individual fields safe.
    for (const field of COPY_FIELDS) {
      const current = doc[field] ?? null;
      const expected = entry.before[field];
      const desired = Object.hasOwn(entry.set, field)
        ? entry.set[field]
        : expected;
      if (current !== expected && current !== desired) {
        throw new CopyUpdateError(
          `Unreviewed ${field} change on ${entry.slug}; refusing to overwrite it.`,
        );
      }
    }
    const set = Object.fromEntries(
      fields
        .filter((field) => doc[field] !== entry.set[field])
        .map((field) => [field, entry.set[field]]),
    );
    if (Object.keys(set).length === 0) continue;
    plan.push({
      id: doc._id,
      revision: doc._rev,
      slug: entry.slug,
      title: entry.title,
      before: Object.fromEntries(
        Object.keys(set).map((field) => [field, doc[field]]),
      ),
      set,
    });
  }
  return plan;
}

export async function saveBackup(plan, directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString();
  const filename = path.resolve(
    directory,
    `service-descriptions-production-${timestamp.replace(/[:.]/g, "-")}-${randomUUID()}.json`,
  );
  await writeFile(
    filename,
    `${JSON.stringify(
      {
        ...TARGET,
        createdAt: timestamp,
        changes: plan,
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return filename;
}

export async function runUpdate({
  client,
  readDocuments,
  apply = false,
  backupDir = ".backups",
  backup = saveBackup,
  log = console.log,
}) {
  assertTarget(client.config());
  const plan = buildUpdatePlan(await readDocuments());
  log(
    `Target: ${TARGET.projectId}/${TARGET.dataset}. Mode: ${apply ? "APPLY" : "DRY RUN"}.`,
  );
  if (plan.length === 0) {
    log(
      "All six services already contain the approved copy. No changes needed.",
    );
    return { changed: 0, applied: false };
  }
  log(JSON.stringify(plan, null, 2));
  if (!apply) {
    log(
      `Dry run: ${plan.length} service documents would change. No writes submitted.`,
    );
    return { changed: plan.length, applied: false };
  }

  const backupPath = await backup(plan, backupDir);
  log(`Before-update backup: ${backupPath}`);
  let transaction = client.transaction();
  for (const change of plan) {
    transaction = transaction.patch(change.id, (patch) =>
      patch.ifRevisionId(change.revision).set(change.set),
    );
  }
  await transaction.commit({ visibility: "sync", returnDocuments: false });
  if (buildUpdatePlan(await readDocuments()).length > 0) {
    throw new CopyUpdateError(
      "The transaction returned, but approved copy could not be verified. Inspect production and the backup before retrying.",
    );
  }
  log(
    `Applied and verified the approved copy on ${plan.length} published service documents.`,
  );
  return { changed: plan.length, applied: true, backupPath };
}

export function safeErrorMessage(error) {
  return error instanceof CopyUpdateError
    ? error.message
    : "Service copy update failed or could not be confirmed. Inspect any saved backup and run a dry run before retrying. Upstream error details are omitted to protect credentials.";
}

export async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node --import tsx scripts/update-approved-service-descriptions.mjs [options]

Updates the six user-approved service descriptions in 3auncj84/production.
Only Lash Fill also updates shortDescription. Other fields are preserved.

  --dry-run             Default: read and display the proposed changes only.
  --apply               Back up, update published documents, then verify.
  --backup-dir <path>   Backup directory for --apply (default: .backups).
  --help                Show this help.

Load a Sanity token using environment variables or .env.local. Dry runs need
SANITY_API_READ_TOKEN or SANITY_WRITE_TOKEN with draft/release read access;
--apply needs SANITY_WRITE_TOKEN. Configured project/dataset must match the
fixed production target. Existing drafts, unexpected copy, or revisions
changed during the update stop the transaction. No documents are created.`);
    return;
  }
  nextEnv.loadEnvConfig(process.cwd());
  const config = getClientConfig(process.env, options.apply);
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ??= TARGET.projectId;
  process.env.NEXT_PUBLIC_SANITY_DATASET ??= TARGET.dataset;
  const [{ createClient }, { getServiceDescriptionMaintenanceDocuments }] =
    await Promise.all([
      import("@sanity/client"),
      import("../src/data/loaders.ts"),
    ]);
  const client = createClient(config);
  await runUpdate({
    ...options,
    client,
    readDocuments: () => getServiceDescriptionMaintenanceDocuments(client),
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  });
}
