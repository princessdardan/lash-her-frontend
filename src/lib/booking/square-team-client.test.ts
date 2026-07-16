import assert from "node:assert/strict";
import test from "node:test";

import { createSquareTeamClient } from "./square-team-client";

test("Square Team search paginates, filters by active location, and includes the owner", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const responses = [
    {
      cursor: "next-page",
      team_members: [
        {
          assigned_locations: { location_ids: ["LOC-1"] },
          family_name: "Provider",
          given_name: "Ava",
          id: "member-1",
          status: "ACTIVE",
        },
        {
          assigned_locations: { location_ids: ["OTHER"] },
          id: "member-other-location",
          status: "ACTIVE",
        },
      ],
    },
    {
      team_members: [
        {
          assigned_locations: {
            assignment_type: "ALL_CURRENT_AND_FUTURE_LOCATIONS",
          },
          email_address: "owner@example.com",
          id: "owner-1",
          is_owner: true,
          status: "ACTIVE",
        },
        {
          assigned_locations: { location_ids: ["LOC-1"] },
          id: "inactive-1",
          status: "INACTIVE",
        },
      ],
    },
  ];
  const fetchImplementation: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json(responses.shift());
  };

  const members = await createSquareTeamClient(
    {
      accessToken: "secret-token",
      environment: "sandbox",
      locationId: "LOC-1",
    },
    fetchImplementation,
  ).listActiveLocationMembers();

  assert.deepEqual(members, [
    {
      displayLabel: "owner@example.com (account owner)",
      id: "owner-1",
      isOwner: true,
      status: "active",
    },
    {
      displayLabel: "Ava Provider",
      id: "member-1",
      isOwner: false,
      status: "active",
    },
  ]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]?.query, {
    filter: { location_ids: ["LOC-1"], status: "ACTIVE" },
  });
  assert.equal(requests[1]?.cursor, "next-page");
});

test("Square Team search rejects malformed responses without returning partial data", async () => {
  const client = createSquareTeamClient(
    {
      accessToken: "secret-token",
      environment: "production",
      locationId: "LOC-1",
    },
    async () => Response.json({ team_members: [{ id: 42, status: "ACTIVE" }] }),
  );

  await assert.rejects(
    client.listActiveLocationMembers(),
    /response was malformed/,
  );
});

test("Square Team search sanitizes provider errors", async () => {
  const client = createSquareTeamClient(
    {
      accessToken: "secret-token",
      environment: "production",
      locationId: "LOC-1",
    },
    async () =>
      new Response(JSON.stringify({ errors: [{ detail: "sensitive detail" }] }), {
        status: 503,
      }),
  );

  await assert.rejects(client.listActiveLocationMembers(), (error: unknown) => {
    assert.match(String(error), /status 503/);
    assert.doesNotMatch(String(error), /sensitive detail/);
    return true;
  });
});
