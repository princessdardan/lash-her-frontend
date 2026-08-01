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
      new Response(
        JSON.stringify({ errors: [{ detail: "sensitive detail" }] }),
        {
          status: 503,
        },
      ),
  );

  await assert.rejects(client.listActiveLocationMembers(), (error: unknown) => {
    assert.match(String(error), /status 503/);
    assert.doesNotMatch(String(error), /sensitive detail/);
    return true;
  });
});

test("Square Team retrieval classifies active, inactive, wrong-location, and missing mappings", async () => {
  const requestedUrls: string[] = [];
  const responses = new Map<string, Response>([
    [
      "active-1",
      Response.json({
        team_member: {
          assigned_locations: { location_ids: ["LOC-1"] },
          given_name: "Active",
          id: "active-1",
          status: "ACTIVE",
        },
      }),
    ],
    [
      "inactive-1",
      Response.json({
        team_member: {
          assigned_locations: { location_ids: ["LOC-1"] },
          family_name: "Provider",
          given_name: "Inactive",
          id: "inactive-1",
          status: "INACTIVE",
        },
      }),
    ],
    [
      "moved-1",
      Response.json({
        team_member: {
          assigned_locations: { location_ids: ["OTHER"] },
          given_name: "Moved",
          id: "moved-1",
          status: "ACTIVE",
        },
      }),
    ],
    ["missing-1", new Response(null, { status: 404 })],
  ]);
  const client = createSquareTeamClient(
    {
      accessToken: "secret-token",
      environment: "sandbox",
      locationId: "LOC-1",
    },
    async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);
      assert.equal(init?.method, "GET");
      const id = decodeURIComponent(url.split("/").at(-1) ?? "");
      return responses.get(id) ?? new Response(null, { status: 500 });
    },
  );

  assert.deepEqual(await client.retrieveLocationMember("active-1"), {
    displayLabel: "Active",
    id: "active-1",
    isOwner: false,
    status: "active",
  });
  assert.deepEqual(await client.retrieveLocationMember("inactive-1"), {
    displayLabel: "Inactive Provider",
    id: "inactive-1",
    isOwner: false,
    status: "inactive",
  });
  assert.deepEqual(await client.retrieveLocationMember("moved-1"), {
    displayLabel: "Moved",
    id: "moved-1",
    isOwner: false,
    status: "missing",
  });
  assert.deepEqual(await client.retrieveLocationMember("missing-1"), {
    displayLabel: null,
    id: "missing-1",
    isOwner: false,
    status: "missing",
  });
  assert.equal(requestedUrls.length, 4);
});

test("Square Team retrieval rejects mismatched and malformed member responses", async () => {
  const mismatchedClient = createSquareTeamClient(
    {
      accessToken: "secret-token",
      environment: "production",
      locationId: "LOC-1",
    },
    async () =>
      Response.json({
        team_member: { id: "different-id", status: "ACTIVE" },
      }),
  );
  await assert.rejects(
    mismatchedClient.retrieveLocationMember("requested-id"),
    /response was malformed/,
  );

  const malformedClient = createSquareTeamClient(
    {
      accessToken: "secret-token",
      environment: "production",
      locationId: "LOC-1",
    },
    async () =>
      Response.json({
        team_member: { id: "requested-id", status: "SUSPENDED" },
      }),
  );
  await assert.rejects(
    malformedClient.retrieveLocationMember("requested-id"),
    /response was malformed/,
  );
});

test("Square Team retrieval sanitizes non-not-found errors", async () => {
  const client = createSquareTeamClient(
    {
      accessToken: "secret-token",
      environment: "production",
      locationId: "LOC-1",
    },
    async () =>
      new Response(
        JSON.stringify({ errors: [{ detail: "sensitive detail" }] }),
        {
          status: 503,
        },
      ),
  );

  await assert.rejects(
    client.retrieveLocationMember("member-1"),
    (error: unknown) => {
      assert.match(String(error), /status 503/);
      assert.doesNotMatch(String(error), /sensitive detail/);
      return true;
    },
  );
});
