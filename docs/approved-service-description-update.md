# Approved service description update

The six replacement descriptions were approved on 2026-10-05. Their exact text
and reviewed original values are in `scripts/approved-service-descriptions.json`.

`scripts/update-approved-service-descriptions.mjs` targets **3auncj84/production**
only. It updates `description` on Tooth Gem, Lash Fill, Mini Lash Fill, Brow
Waxing, Mobile Lash Appointment, and Tailored To Her Full Lash Set. It also
updates Lash Fill's `shortDescription` with the same approved text. Titles,
slugs, SEO, images, other services, and booking records are unchanged.

## Preview and apply

Run from the checkout containing the script. Use environment variables or the
checkout's `.env.local` to supply a Sanity token with access to this project and
dataset. Dry runs require `SANITY_API_READ_TOKEN` or `SANITY_WRITE_TOKEN` with
access to drafts and releases. Applying requires `SANITY_WRITE_TOKEN` with
permission to read those variants and update published service documents.
No token is printed or included in backups.

Preview the before/after values without submitting any mutations:

```sh
NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84 NEXT_PUBLIC_SANITY_DATASET=production \
  node --import tsx scripts/update-approved-service-descriptions.mjs --dry-run
```

Apply the approved replacements:

```sh
NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84 NEXT_PUBLIC_SANITY_DATASET=production \
  node --import tsx scripts/update-approved-service-descriptions.mjs --apply
```

When credentials are in a separate file, Node's `--env-file=/absolute/path/to/file`
can be placed before `--import tsx`. Keep the explicit project and dataset above.

## Update behavior

- Dry run is the default; only `--apply` writes.
- Every target must resolve to exactly one published service. A draft or release
  for any target stops the run, including a draft whose slug has changed. Finish
  or discard pending editorial work before running, and avoid editing these
  documents while the script runs.
- Current descriptions must match either the reviewed original copy or the exact
  approved replacements. Unexpected editorial changes stop the run. Already
  approved fields are left alone, so repeating a completed update is a no-op.
- Before writing, the script saves document IDs, revisions, and exact before/after
  field values in a unique, owner-readable JSON file under `.backups/`. Use
  `--backup-dir /path/to/directory` to choose another location. Backup failure
  prevents the mutation.
- All patches go into one transaction, conditional on each document's revision.
  A revision conflict prevents the entire transaction. The script reads the
  documents again after a successful response to verify the approved copy.
- A connection failure can leave the transaction outcome uncertain. Keep the
  backup and rerun a dry run to inspect current state before retrying. There is
  no automatic rollback; the backup provides the exact old values for a reviewed
  recovery without overwriting subsequent edits.
- The configured Sanity webhook should revalidate the existing `service` cache
  tag. Verify `/services` and the affected detail pages after applying; no schema
  deployment is needed for these existing text fields.

## Verification

```sh
node --test scripts/update-approved-service-descriptions.test.mjs
```

The tests cover dry-run behavior, target/credential checks, missing and duplicate
documents, unpublished edits, unexpected text changes, field scope, backups,
revision conflicts, atomic patch construction, verification, and repeat runs.

A production dry run on 2026-10-05 found six documents requiring seven field
updates and no conflicting drafts or releases. No production mutations were
submitted during script preparation.
