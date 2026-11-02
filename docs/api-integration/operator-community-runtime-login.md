# Community staging runtime credential

The existing `lash_her_community_staging_runtime` role is restricted and LOGIN-enabled. A fresh November 2 TLS read-only check found no elevated attributes, database/public-schema CREATE or neon_superuser membership, no public application tables and no active runtime connections. Its credential was not injected into the checked frontend Environment or Community repo `.env`. Do not recreate the role or substitute the owner's password.

## 1. Prepare the existing 1Password Environment

Use the Environment mounted at `/Users/dardan/workspace/lash-her-frontend/.env`; edit it in the 1Password app, not the mounted file.

1. Add `COMMUNITY_STAGING_RUNTIME_DATABASE_URL`.
2. Use the existing saved password for `lash_her_community_staging_runtime` if available. Otherwise generate a new, distinct password with at least 32 letters/digits and keep it in 1Password.
3. Save this exact URL with that password substituted privately:

   ```text
   postgresql://lash_her_community_staging_runtime:YOUR_PASSWORD@ep-fancy-glitter-b81a2g6r.c-14.us-east-1.aws.neon.tech/neondb?sslmode=verify-full
   ```

4. Keep the literal role name, direct endpoint, database and TLS query unchanged. Do not replace or modify `COMMUNITY_STAGING_DATABASE_URL`, which supplies the existing migration/admin connection.
5. Report only that the binding is saved and whether the password is existing or newly generated. Never send the URL/password in chat.

Saving a newly generated value in 1Password does not configure PostgreSQL. Do not reset the password separately in the Neon Console. A console reset generates a different value; a runtime role must not be recreated through an interface that grants administrator membership. See [Neon role management](https://neon.com/docs/manage/roles).

## 2. Verify or deliberately configure

The following reviewed source command defaults to a public plan, without reading credentials or contacting PostgreSQL:

```sh
node ops/staging/provision-community-runtime-login.mjs
```

For an existing credential, verify it without changing any password or grant:

```sh
node ops/staging/provision-community-runtime-login.mjs --verify \
  --env-file /Users/dardan/workspace/lash-her-frontend/.env
```

If Dardan generated a new password for this initial, unused staging role, the explicit setup action is:

```sh
node ops/staging/provision-community-runtime-login.mjs \
  --apply --confirm staging/community-runtime-credential \
  --env-file /Users/dardan/workspace/lash-her-frontend/.env
```

This sets only the existing runtime role's password. It checks the exact endpoint/database/admin identity and PostgreSQL18, verified TLS, restricted attributes, absent elevated memberships, no runtime CREATE privileges, empty application/migration schemas, zero runtime connections, the owner's admin option and the setup advisory lock. It does not create roles, enable logins, change grants, apply migrations or deploy containers. It sends a driver-escaped private password literal over verified TLS with transaction-local SCRAM encryption, then verifies a fresh read-only TLS login.

`COMMUNITY_RUNTIME_LOGIN_VERIFIED` proves that fresh connection passed. Failures return fixed phase/SQLSTATE and commit acknowledgement state; no raw error or credential is printed. A failed or uncertain COMMIT must be reconciled by inspecting actual state and verifying the same stored credential. Do not automatically retry, generate another password or run apply again after an observation failure. This is an initial empty-staging handoff, not a routine credential-rotation tool; a populated database or active runtime connection refuses apply.

Thirteen owned PostgreSQL18 checks pass locally. The fixture runs with external networking disabled and synthetic TLS/SCRAM credentials. It exercises wrong target/weaker TLS/shared-password refusal, read-only verification, lock/population/privilege/active-client refusals, rollback and sanitized uncertain COMMIT behavior, actual escaped-password authentication and denial of the old password. It never accepts a cloud database URL.
