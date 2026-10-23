import { Ajv2020 } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import document from "../../../contracts/api-integration/v1/boundary-contracts.json";
import type { components } from "@/lib/api-integration/generated/boundaries";

type Schemas = components["schemas"];
type Claims =
  | "CourseLearnerClaims"
  | "CommunityMemberClaims"
  | "CourseAdminClaims"
  | "CommunityAdminClaims";
const ajv = new Ajv2020({
  strict: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
});
addFormats(ajv);
const validators = Object.fromEntries(
  Object.entries(document.components.schemas).map(([name, schema]) => [
    name,
    ajv.compile(schema),
  ]),
);

export function parseBoundary<N extends keyof Schemas>(
  name: N,
  value: unknown,
): Schemas[N] {
  if (!validators[name](value))
    throw new Error("Invalid integration boundary payload");
  return value as Schemas[N];
}

/** Contract validation only. Receivers must verify the signature before calling. */
export function parseApiClaims<N extends Claims>(
  name: N,
  value: unknown,
  nowSeconds: number,
): Schemas[N] {
  const claims = parseBoundary(name, value);
  if (
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds < 0 ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 300 ||
    claims.iat > nowSeconds + 30 ||
    claims.exp <= nowSeconds - 30
  ) {
    throw new Error("Invalid integration JWT lifetime");
  }
  return claims;
}
