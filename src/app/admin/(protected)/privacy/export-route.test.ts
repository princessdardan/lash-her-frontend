import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createPrivacyExportPostHandler } from "./src/app/admin/(protected)/privacy/[id]/export/route.ts";

  const owner = {
    user: {
      displayName: "Owner",
      email: "owner@example.com",
      emailNormalized: "owner@example.com",
      id: "admin-owner",
      providerUserId: "clerk-owner",
      role: "owner",
      status: "active",
    },
  };

  function createRequest(reason = "Customer access request") {
    const formData = new FormData();
    formData.set("reason", reason);

    return new Request("https://lash.test/admin/privacy/privacy-1/export", {
      body: formData,
      method: "POST",
    });
  }
`;

test("privacy export route rejects operator", () => {
  runScenario(`
    const handler = createPrivacyExportPostHandler({
      requireOwner: async () => { throw new Error("forbidden"); },
      buildExport: async () => { throw new Error("should not export"); },
    });

    const response = await handler(createRequest(), { params: Promise.resolve({ id: "privacy-1" }) });

    assert.equal(response.status, 403);
  `);
});

test("privacy export route requires reason", () => {
  runScenario(`
    const handler = createPrivacyExportPostHandler({
      requireOwner: async () => owner,
      buildExport: async () => { throw new Error("should not export"); },
    });

    const response = await handler(createRequest(""), { params: Promise.resolve({ id: "privacy-1" }) });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Export reason is required" });
  `);
});

test("privacy export route returns attachment json", () => {
  runScenario(`
    const handler = createPrivacyExportPostHandler({
      requireOwner: async () => owner,
      buildExport: async (input) => ({ privacyRequestId: input.privacyRequestId, reason: input.reason, records: {} }),
    });

    const response = await handler(createRequest(), { params: Promise.resolve({ id: "privacy-1" }) });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="privacy-export-privacy-1.json"');
    assert.deepEqual(await response.json(), { privacyRequestId: "privacy-1", reason: "Customer access request", records: {} });
  `);
});

function runScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };
  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  execFileSync("./node_modules/.bin/tsx", ["--conditions=react-server", "--eval", scenario], {
    cwd: process.cwd(),
    env,
    stdio: "pipe",
  });
}
