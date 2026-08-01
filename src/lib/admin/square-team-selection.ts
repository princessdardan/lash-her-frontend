import "server-only";

import { createHmac } from "node:crypto";

const HANDLE_VERSION = "sqtm_v1";
const HANDLE_CONTEXT = "lash-her:square-team-member-selection:v1";
const MAX_TEAM_MEMBER_ID_LENGTH = 512;

export interface SquareTeamMemberSelectionCandidate {
  displayLabel: string;
  id: string;
  isOwner: boolean;
  status: "active" | "inactive" | "missing";
}

export interface SquareTeamMemberSelectionOption {
  displayLabel: string;
  isOwner: boolean;
  selectionHandle: string;
  status: "active" | "inactive" | "missing";
}

export function createSquareTeamMemberSelectionOption(
  member: SquareTeamMemberSelectionCandidate,
  secret: string,
): SquareTeamMemberSelectionOption {
  return {
    displayLabel: member.displayLabel,
    isOwner: member.isOwner,
    selectionHandle: createSelectionHandle(member.id, secret),
    status: member.status,
  };
}

export function resolveSquareTeamMemberSelection(
  selectionHandle: string,
  members: SquareTeamMemberSelectionCandidate[],
  secret: string,
): SquareTeamMemberSelectionCandidate | null {
  if (!isValidSelectionHandle(selectionHandle)) {
    return null;
  }

  return (
    members.find(
      (member) => createSelectionHandle(member.id, secret) === selectionHandle,
    ) ?? null
  );
}

function createSelectionHandle(teamMemberId: string, secret: string): string {
  const normalizedId = teamMemberId.trim();
  const normalizedSecret = secret.trim();
  if (
    normalizedId.length === 0 ||
    normalizedId.length > MAX_TEAM_MEMBER_ID_LENGTH ||
    normalizedSecret.length === 0
  ) {
    throw new Error("Square team member selection cannot be created");
  }

  const digest = createHmac("sha256", normalizedSecret)
    .update(HANDLE_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(normalizedId, "utf8")
    .digest("base64url");
  return `${HANDLE_VERSION}.${digest}`;
}

function isValidSelectionHandle(value: string): boolean {
  return new RegExp(`^${HANDLE_VERSION}\\.[A-Za-z0-9_-]{43}$`).test(value);
}
