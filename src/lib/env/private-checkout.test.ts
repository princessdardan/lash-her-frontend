import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { getCheckoutDatabaseUrl } from "./src/lib/env/private-checkout.ts";

  assert.equal(getCheckoutDatabaseUrl(), "postgres://neon-pooled-url");
`;

test("checkout database URL uses Neon DATABASE_URL", () => {
  const env = { ...process.env };

  env.DATABASE_URL = "postgres://neon-pooled-url";

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", helperScript],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
});
