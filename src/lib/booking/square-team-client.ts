import "server-only";

const SQUARE_VERSION = "2026-05-20";
const SQUARE_BASE_URLS = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
} as const;
const PAGE_LIMIT = 100;
const MAX_PAGES = 100;

export interface SquareTeamMemberOption {
  displayLabel: string;
  id: string;
  isOwner: boolean;
  status: "active";
}

export interface SquareTeamClientEnv {
  accessToken: string;
  environment: "sandbox" | "production";
  locationId: string;
}

export interface SquareTeamClient {
  listActiveLocationMembers(): Promise<SquareTeamMemberOption[]>;
}

interface SquareTeamSearchMember {
  assigned_locations?: {
    assignment_type?: string;
    location_ids?: string[];
  };
  email_address?: string;
  family_name?: string;
  given_name?: string;
  id: string;
  is_owner?: boolean;
  status: string;
}

interface SquareTeamSearchResponse {
  cursor?: string;
  team_members: SquareTeamSearchMember[];
}

export function createSquareTeamClient(
  env: SquareTeamClientEnv,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): SquareTeamClient {
  const accessToken = requireConfig(env.accessToken, "Square access token");
  const locationId = requireConfig(env.locationId, "Square location ID");

  return {
    async listActiveLocationMembers() {
      const members = new Map<string, SquareTeamMemberOption>();
      const visitedCursors = new Set<string>();
      let cursor: string | undefined;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await searchTeamMembers({
          accessToken,
          cursor,
          environment: env.environment,
          fetchImplementation,
          locationId,
        });

        for (const member of response.team_members) {
          if (!isEligibleForLocation(member, locationId)) {
            continue;
          }

          members.set(member.id, {
            displayLabel: toDisplayLabel(member),
            id: member.id,
            isOwner: member.is_owner === true,
            status: "active",
          });
        }

        cursor = response.cursor;
        if (cursor === undefined) {
          return [...members.values()].sort(compareTeamMembers);
        }
        if (visitedCursors.has(cursor)) {
          throw new Error("Square Team API returned a repeated cursor");
        }
        visitedCursors.add(cursor);
      }

      throw new Error("Square Team API pagination limit was exceeded");
    },
  };
}

async function searchTeamMembers(input: {
  accessToken: string;
  cursor?: string;
  environment: "sandbox" | "production";
  fetchImplementation: typeof globalThis.fetch;
  locationId: string;
}): Promise<SquareTeamSearchResponse> {
  let response: Response;

  try {
    response = await input.fetchImplementation(
      `${SQUARE_BASE_URLS[input.environment]}/v2/team-members/search`,
      {
        body: JSON.stringify({
          ...(input.cursor ? { cursor: input.cursor } : {}),
          limit: PAGE_LIMIT,
          query: {
            filter: {
              location_ids: [input.locationId],
              status: "ACTIVE",
            },
          },
        }),
        cache: "no-store",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.accessToken}`,
          "content-type": "application/json",
          "square-version": SQUARE_VERSION,
        },
        method: "POST",
      },
    );
  } catch {
    throw new Error("Square Team API request failed before receiving a response");
  }

  if (!response.ok) {
    throw new Error(`Square Team API request failed with status ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Square Team API response was malformed");
  }

  if (!isSquareTeamSearchResponse(payload)) {
    throw new Error("Square Team API response was malformed");
  }

  return payload;
}

function isSquareTeamSearchResponse(
  value: unknown,
): value is SquareTeamSearchResponse {
  if (!isRecord(value) || !Array.isArray(value.team_members)) {
    return false;
  }
  if (
    "cursor" in value &&
    value.cursor !== undefined &&
    !isNonemptyBoundedString(value.cursor)
  ) {
    return false;
  }

  return value.team_members.every(isSquareTeamSearchMember);
}

function isSquareTeamSearchMember(
  value: unknown,
): value is SquareTeamSearchMember {
  if (
    !isRecord(value) ||
    !isNonemptyBoundedString(value.id) ||
    !isNonemptyBoundedString(value.status)
  ) {
    return false;
  }

  for (const key of ["email_address", "family_name", "given_name"] as const) {
    if (
      key in value &&
      value[key] !== undefined &&
      !isNonemptyBoundedString(value[key])
    ) {
      return false;
    }
  }

  if (
    "is_owner" in value &&
    value.is_owner !== undefined &&
    typeof value.is_owner !== "boolean"
  ) {
    return false;
  }

  if (
    "assigned_locations" in value &&
    value.assigned_locations !== undefined
  ) {
    if (!isRecord(value.assigned_locations)) {
      return false;
    }
    const assigned = value.assigned_locations;
    if (
      "assignment_type" in assigned &&
      assigned.assignment_type !== undefined &&
      !isNonemptyBoundedString(assigned.assignment_type)
    ) {
      return false;
    }
    if (
      "location_ids" in assigned &&
      assigned.location_ids !== undefined &&
      (!Array.isArray(assigned.location_ids) ||
        !assigned.location_ids.every(isNonemptyBoundedString))
    ) {
      return false;
    }
  }

  return true;
}

function isEligibleForLocation(
  member: SquareTeamSearchMember,
  locationId: string,
): boolean {
  if (member.status !== "ACTIVE") {
    return false;
  }

  const assigned = member.assigned_locations;
  if (assigned === undefined) {
    return true;
  }
  if (assigned.assignment_type === "ALL_CURRENT_AND_FUTURE_LOCATIONS") {
    return true;
  }

  return assigned.location_ids?.includes(locationId) === true;
}

function toDisplayLabel(member: SquareTeamSearchMember): string {
  const fullName = [member.given_name, member.family_name]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .trim();
  const base = fullName || member.email_address?.trim() || "Square team member";
  return member.is_owner === true ? `${base} (account owner)` : base;
}

function compareTeamMembers(
  first: SquareTeamMemberOption,
  second: SquareTeamMemberOption,
): number {
  if (first.isOwner !== second.isOwner) {
    return first.isOwner ? -1 : 1;
  }
  return first.displayLabel.localeCompare(second.displayLabel);
}

function requireConfig(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function isNonemptyBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
