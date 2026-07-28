import assert from "node:assert/strict";
import test from "node:test";

import {
  createSquareTeamMemberSelectionOption,
  resolveSquareTeamMemberSelection,
  type SquareTeamMemberSelectionCandidate,
} from "./square-team-selection";

const member: SquareTeamMemberSelectionCandidate = {
  displayLabel: "Ava Provider",
  id: "square-team-member-secret-id",
  isOwner: false,
  status: "active",
};

test("Square team selection handles do not disclose provider IDs", () => {
  const option = createSquareTeamMemberSelectionOption(
    member,
    "server-only-secret",
  );

  assert.match(option.selectionHandle, /^sqtm_v1\.[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(option.selectionHandle, /square-team-member-secret-id/);
  assert.equal(
    JSON.stringify(option).includes("square-team-member-secret-id"),
    false,
  );
});

test("Square team selection handles resolve only with the current server secret and roster", () => {
  const option = createSquareTeamMemberSelectionOption(
    member,
    "server-only-secret",
  );

  assert.deepEqual(
    resolveSquareTeamMemberSelection(
      option.selectionHandle,
      [member],
      "server-only-secret",
    ),
    member,
  );
  assert.equal(
    resolveSquareTeamMemberSelection(
      option.selectionHandle,
      [member],
      "rotated-secret",
    ),
    null,
  );
  assert.equal(
    resolveSquareTeamMemberSelection(
      option.selectionHandle,
      [],
      "server-only-secret",
    ),
    null,
  );
  assert.equal(
    resolveSquareTeamMemberSelection(
      "sqtm_v1.invalid",
      [member],
      "server-only-secret",
    ),
    null,
  );
});
