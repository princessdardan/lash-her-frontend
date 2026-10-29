import "server-only";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import course from "../../../contracts/api-integration/v1/course-api.json";
import community from "../../../contracts/api-integration/v1/community-api.json";
import type { paths as CoursePaths } from "@/lib/api-integration/generated/course";
import type { paths as CommunityPaths } from "@/lib/api-integration/generated/community";

type Method = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";
type Responses<Operation> = Operation extends { responses: infer R }
  ? R
  : never;
type JsonBody<Response> = Response extends {
  content: { "application/json": infer B };
}
  ? B
  : never;
type Service = "course" | "community";
interface ResponseSchema {
  description?: string;
  content?: Record<string, { schema?: object }>;
  $ref?: string;
}
interface Document {
  paths: Record<
    string,
    Partial<Record<Method, { responses: Record<string, ResponseSchema> }>>
  >;
  components?: {
    schemas?: Record<string, object>;
    responses?: Record<string, ResponseSchema>;
  };
}
const documents: Record<Service, Document> = { course, community };
const validators = new Map<string, ValidateFunction>();
const ajv = new Ajv2020({
  strict: false,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
});
addFormats(ajv);
for (const service of ["course", "community"] as const) {
  ajv.addSchema(documents[service], `urn:lash-her:${service}`);
}

export class ApiContractError extends Error {
  constructor() {
    // Never include upstream bodies, Ajv value details, identities or credentials.
    super("Upstream response does not match the pinned API contract");
    this.name = "ApiContractError";
  }
}

export function validateApiResponse(
  service: Service,
  path: string,
  method: Method,
  status: number,
  value: unknown,
): void {
  const document = documents[service];
  const responses = document.paths[path]?.[method]?.responses;
  const responseKey = String(status);
  let response = responses?.[responseKey];
  if (!response) throw new ApiContractError();
  if (response.$ref) {
    const match = /^#\/components\/responses\/([^/]+)$/.exec(response.$ref);
    response = match ? document.components?.responses?.[match[1]] : undefined;
  }
  const schema = response?.content?.["application/json"]?.schema;
  if (!schema) throw new ApiContractError();
  const key = `${service}:${method}:${path}:${responseKey}`;
  let validate = validators.get(key);
  if (!validate) {
    // Local references in response schemas resolve against the pinned document.
    validate = ajv.compile({ ...schema, components: document.components });
    validators.set(key, validate);
  }
  if (!validate(value)) throw new ApiContractError();
}

export function parseCourseResponse<
  P extends keyof CoursePaths,
  M extends Method & keyof CoursePaths[P],
  S extends number & keyof Responses<CoursePaths[P][M]>,
>(
  path: P,
  method: M,
  status: S,
  value: unknown,
): JsonBody<Responses<CoursePaths[P][M]>[S]> {
  validateApiResponse("course", path, method, status, value);
  return value as JsonBody<Responses<CoursePaths[P][M]>[S]>;
}

export function parseCommunityResponse<
  P extends keyof CommunityPaths,
  M extends Method & keyof CommunityPaths[P],
  S extends number & keyof Responses<CommunityPaths[P][M]>,
>(
  path: P,
  method: M,
  status: S,
  value: unknown,
): JsonBody<Responses<CommunityPaths[P][M]>[S]> {
  validateApiResponse("community", path, method, status, value);
  return value as JsonBody<Responses<CommunityPaths[P][M]>[S]>;
}
