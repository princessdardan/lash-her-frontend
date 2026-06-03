import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function runScenario(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "privacy-requests-test-"));
  const scenarioPath = join(directory, "scenario.ts");

  try {
    await writeFile(scenarioPath, source);
    const { stderr } = await execFileAsync("./node_modules/.bin/tsx", ["--conditions=react-server", scenarioPath], {
      cwd: process.cwd(),
    });

    assert.equal(stderr, "");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function createScenario(body: string): string {
  const moduleUrl = pathToFileURL(join(process.cwd(), "src/lib/admin/privacy-requests.ts")).href;

  return String.raw`
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

    function createRepository() {
      const events = [];
      const requests = [];

      return {
        events,
        requests,
        async createPrivacyRequest(input) {
          const request = {
            id: "privacy-" + (requests.length + 1),
            completedAt: null,
            ownerDecision: null,
            status: "open",
            ...input,
          };
          requests.push(request);
          return request;
        },
        async createPrivacyRequestEvent(input) {
          const event = { id: "event-" + (events.length + 1), createdAt: new Date(events.length), ...input };
          events.push(event);
          return { id: event.id };
        },
        async findPrivacyRequestById(id) {
          return requests.find((request) => request.id === id) ?? null;
        },
        async listPrivacyRequestEvents(privacyRequestId) {
          return events
            .filter((event) => event.privacyRequestId === privacyRequestId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        },
        async updatePrivacyRequestStatus(id, status, completedAt) {
          const request = requests.find((row) => row.id === id);
          request.status = status;
          request.completedAt = completedAt;
          return request;
        },
      };
    }

    async function main() {
      const { createPrivacyRequestService } = await import(${JSON.stringify(moduleUrl)});
      ${body}
    }

    main().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
}

test("privacy request service creates request and created event", async () => {
  await runScenario(createScenario(String.raw`
    const repository = createRepository();
    const service = createPrivacyRequestService(repository);

    const request = await service.createRequest({
      actor,
      requestType: "access_export",
      requesterName: " Client Example ",
      requesterNotes: " Customer asked for records ",
      subjectEmail: " Client@Example.com ",
    });

    assert.equal(request.subjectEmail, "Client@Example.com");
    assert.equal(request.subjectEmailNormalized, "client@example.com");
    assert.equal(request.requesterName, "Client Example");
    assert.equal(request.requesterNotes, "Customer asked for records");
    assert.equal(request.createdByAdminUserId, "admin-owner");
    assert.equal(repository.events[0].eventType, "created");
    assert.equal(repository.events[0].actorAdminUserId, "admin-owner");
    assert.deepEqual(repository.events[0].metadata, { requestType: "access_export" });
  `));
});

test("privacy request service records status changes", async () => {
  await runScenario(createScenario(String.raw`
    const repository = createRepository();
    const service = createPrivacyRequestService(repository);
    const request = await service.createRequest({
      actor,
      requestType: "access_export",
      subjectEmail: "client@example.com",
    });

    await service.changeStatus({ actor, privacyRequestId: request.id, status: "completed" });
    const firstCompletedAt = repository.requests[0].completedAt;
    await service.changeStatus({ actor, privacyRequestId: request.id, status: "completed" });

    assert.equal(repository.requests[0].status, "completed");
    assert.ok(repository.requests[0].completedAt instanceof Date);
    assert.equal(repository.requests[0].completedAt, firstCompletedAt);
    assert.equal(repository.events.at(-1).eventType, "status_changed");
    assert.equal(repository.events.at(-1).message, "Status changed to completed");
    assert.deepEqual(repository.events.at(-1).metadata, { status: "completed" });

    await assert.rejects(
      () => service.changeStatus({ actor, privacyRequestId: "missing", status: "completed" }),
      /Privacy request not found/,
    );
  `));
});

test("privacy request service returns request with events or null", async () => {
  await runScenario(createScenario(String.raw`
    const repository = createRepository();
    const service = createPrivacyRequestService(repository);

    assert.equal(await service.getRequestWithEvents("missing"), null);

    const request = await service.createRequest({
      actor,
      requestType: "privacy_inquiry",
      subjectEmail: "client@example.com",
    });
    await service.addEvent({
      actor,
      eventType: "note_added",
      message: "Owner added context",
      privacyRequestId: request.id,
    });

    const result = await service.getRequestWithEvents(request.id);

    assert.equal(result.request.id, request.id);
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].eventType, "note_added");

    await assert.rejects(
      () => service.addEvent({ actor, eventType: "note_added", privacyRequestId: "missing" }),
      /Privacy request not found/,
    );
  `));
});
