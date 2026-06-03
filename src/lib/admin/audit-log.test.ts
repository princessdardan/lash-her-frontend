import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("audit log service stores required actor and target fields", async () => {
  const auditLogModuleUrl = pathToFileURL(join(process.cwd(), "src/lib/admin/audit-log.ts")).href;
  const scenario = String.raw`
    import assert from "node:assert/strict";

    const actor = {
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

    async function main() {
      const { createAuditLogService } = await import(${JSON.stringify(auditLogModuleUrl)});
      const entries = [];
      const repository = {
        async createAuditLogEntry(entry) {
          entries.push(entry);
          return { id: "audit-1" };
        },
      };
      const service = createAuditLogService(repository);

      await service.record({
        action: "privacy_export_attempt",
        actor,
        domain: "privacy",
        metadata: {
          count: 3,
          customerEmail: "client@example.com",
          context: {
            customerEmail: "nested@example.com",
            note: "safe",
            tokenValue: "hidden",
          },
          rawPayload: { secret: "hidden" },
        },
        privacyRequestId: "privacy-1",
        targetId: "privacy-1",
        targetType: "privacy_request",
      });

      assert.equal(entries[0].actorAdminUserId, "admin-owner");
      assert.equal(entries[0].actorEmail, "owner@example.com");
      assert.equal(entries[0].actorRole, "owner");
      assert.equal(entries[0].action, "privacy_export_attempt");
      assert.equal(entries[0].privacyRequestId, "privacy-1");
      assert.equal("reason" in entries[0], false);
      assert.deepEqual(entries[0].metadata, { count: 3, context: { note: "safe" } });
    }

    main().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  const directory = await mkdtemp(join(tmpdir(), "audit-log-test-"));
  const scenarioPath = join(directory, "scenario.ts");

  try {
    await writeFile(scenarioPath, scenario);
    const { stderr } = await execFileAsync("./node_modules/.bin/tsx", ["--conditions=react-server", scenarioPath], {
      cwd: process.cwd(),
    });

    assert.equal(stderr, "");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
