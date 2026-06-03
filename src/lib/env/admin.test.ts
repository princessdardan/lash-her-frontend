import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scenario = String.raw`
  import assert from "node:assert/strict";

  import {
    getAdminEnvironmentLabel,
    parseAdminEmailAllowlists,
    resolveAllowedAdminRole,
  } from "./src/lib/env/admin.ts";

  const allowlists = parseAdminEmailAllowlists({
    ADMIN_OWNER_EMAILS: " Owner@Example.com, ,second@example.com ",
    ADMIN_OPERATOR_EMAILS: " Operator@Example.com, ",
  });

  assert.deepEqual([...allowlists.ownerEmails], ["owner@example.com", "second@example.com"]);
  assert.deepEqual([...allowlists.operatorEmails], ["operator@example.com"]);

  const precedenceAllowlists = parseAdminEmailAllowlists({
    ADMIN_OWNER_EMAILS: "owner@example.com,dual@example.com",
    ADMIN_OPERATOR_EMAILS: "operator@example.com,dual@example.com",
  });

  assert.equal(resolveAllowedAdminRole("dual@example.com", precedenceAllowlists), "owner");
  assert.equal(resolveAllowedAdminRole("operator@example.com", precedenceAllowlists), "operator");
  assert.equal(resolveAllowedAdminRole("unknown@example.com", precedenceAllowlists), null);

  assert.equal(getAdminEnvironmentLabel({ VERCEL_ENV: "production" }), "production");
  assert.equal(getAdminEnvironmentLabel({ VERCEL_ENV: "preview" }), "preview");
  assert.equal(getAdminEnvironmentLabel({ NODE_ENV: "development" }), "local");
  assert.equal(getAdminEnvironmentLabel({}), "unknown");
`;

test("admin environment parsing normalizes allowlists and labels deployment context", () => {
  const result = spawnSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env: { ...process.env },
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
