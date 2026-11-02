# Initial Course staging database logins

Read-only verification on November 2 confirmed that the recorded Course staging
database is PostgreSQL 18 with no public application tables. Its dedicated roles
exist, and the runtime role has login disabled. Dardan confirmed their credentials
are not provisioned. The supplied `COURSE_STAGING_DATABASE_URL` currently contains
the owner credential. Do not place that owner credential in an API or worker.

The initial activation command reuses the existing roles and grants. It does not
create roles, grant database/schema privileges, apply migrations, seed data or
deploy anything. It refuses an existing login, elevated runtime role, populated
target, shared passwords, wrong endpoint or unverified TLS. Both login changes
are transactional. A failed or uncertain result requires inspecting actual state;
it never automatically retries or rotates either password.

## Prepare the three 1Password bindings

Use the existing Environment mounted at
`/Users/dardan/workspace/lash-her-frontend/.env`. Do not edit the mounted file or
put values in chat, shell arguments, Git, logs or screenshots.

1. In the 1Password app, copy the current owner connection value from
   `COURSE_STAGING_DATABASE_URL` into a new secret named
   `COURSE_STAGING_ADMIN_DATABASE_URL`. Do this before replacing the existing
   variable. This credential is used only for initial administrative setup.
2. Generate a new password of at least 32 characters in 1Password. Letters and
   digits avoid URL-encoding mistakes. Replace `COURSE_STAGING_DATABASE_URL` with
   the following connection string, inserting that generated password privately:

   ```text
   postgresql://lash_her_course_staging_migration:<generated-migration-password>@ep-sparkling-moon-b4htlczb.c-6.us-east-2.aws.neon.tech/neondb?sslmode=verify-full
   ```

3. Generate a different password of at least 32 characters. Add the secret
   `COURSE_STAGING_RUNTIME_DATABASE_URL` with:

   ```text
   postgresql://lash_her_course_staging_runtime:<generated-runtime-password>@ep-sparkling-moon-b4htlczb.c-6.us-east-2.aws.neon.tech/neondb?sslmode=verify-full
   ```

Save the Environment changes. These strings deliberately use the direct endpoint
and verified-TLS format consumed by the reviewed release tooling. Updating the
bindings alone does not activate either database role. Preserve the admin value
separately from runtime and migration process configuration. There is no CLI
upgrade or additional secret service requirement; installed 1Password CLI 2.39.0
cannot manage Environment entries, so use the existing app.

## Operator activation

From the reviewed frontend source, show the fixed target and required variable
names without reading any credentials:

```sh
node ops/staging/provision-course-logins.mjs
```

After the three private bindings are ready, the single explicit setup action is:

```sh
node ops/staging/provision-course-logins.mjs \
  --apply --confirm staging/course-initial-logins \
  --env-file /Users/dardan/workspace/lash-her-frontend/.env
```

The command loads values inside its process, verifies the exact recorded
host/database/admin identity and PostgreSQL major, takes the existing role-setup
advisory lock, and rechecks both roles and the empty database. Passwords must be
distinct from each other and the owner password. It sends generated SCRAM
verifiers in the role DDL, commits the two login changes together, then tests new
TLS-authenticated connections for each role in read-only transactions. Output
contains selected success flags and role names only.

Only `COURSE_INITIAL_LOGINS_VERIFIED` confirms both new connections passed. A
failure may occur after the database committed; retain the stored values, inspect
role/login state and test those same credentials privately. Do not generate new
passwords or rerun activation to resolve an observation failure. Existing login
roles are deliberately refused by this initial-setup tool; ordinary credential
rotation is outside its scope.

The owned integration test creates a new loopback-only PostgreSQL 18 cluster
inside the existing owned compatibility image with external networking disabled.
It uses fixture TLS/SCRAM credentials and checks target/password/TLS/lock/privilege/
population refusals, actual transactional rollback, successful authentication and
refusal to rotate active logins, then removes its cluster. It accepts no provider
database URL. From the isolated source checkout, with the owned image built as in
the frontend migration runbook:

```sh
docker run --rm --network none --memory 512m --pids-limit 128 \
  --env COURSE_INITIAL_LOGINS_LOCAL_TEST=true \
  --mount type=bind,source="$PWD",target=/source,readonly \
  --workdir /source --entrypoint node \
  lash-her-frontend-migration:postgres18-test \
  ops/staging/tests/course-initial-logins.integration.mjs
```
