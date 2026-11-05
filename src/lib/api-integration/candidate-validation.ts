import "server-only";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import course from "../../../contracts/api-integration/p2-candidate/course-api.json";
import community from "../../../contracts/api-integration/p2-candidate/community-api.json";
import { ApiContractError } from "./api-contract-error";
import { IntegrationServiceError } from "./service-errors";
import type { paths as CoursePaths } from "./candidate-generated/course";
import type { paths as CommunityPaths } from "./candidate-generated/community";

export type IntegrationService = "course" | "community";
export interface CandidatePaths { course: CoursePaths; community: CommunityPaths }
export type CandidateMethod = "get" | "post" | "patch" | "put" | "delete";
type Operation<S extends IntegrationService, P extends keyof CandidatePaths[S], M extends CandidateMethod> = M extends keyof CandidatePaths[S][P] ? CandidatePaths[S][P][M] : never;
type JsonBody<T> = T extends { content: { "application/json": infer B } } ? B : never;
export type CandidateBody<S extends IntegrationService, P extends keyof CandidatePaths[S], M extends CandidateMethod> = Operation<S, P, M> extends { requestBody: infer B } ? JsonBody<B> : never;
export type CandidateQuery<S extends IntegrationService, P extends keyof CandidatePaths[S], M extends CandidateMethod> = Operation<S, P, M> extends { parameters: { query?: infer Q } } ? Q : never;
export type CandidateSuccess<S extends IntegrationService, P extends keyof CandidatePaths[S], M extends CandidateMethod> = Operation<S, P, M> extends { responses: infer R } ? JsonBody<R[keyof R & (200 | 201 | 202)]> : never;

interface ResponseDocument { description?: string; $ref?: string; content?: Record<string, { schema?: object }> }
interface OperationDocument {
  parameters?: Array<{ in: string; name: string; required?: boolean; schema?: object }>;
  requestBody?: { required?: boolean; content: Record<string, { schema?: object }> };
  responses: Record<string, ResponseDocument>;
}
interface Document { paths: Record<string, Partial<Record<CandidateMethod, OperationDocument>>>; components?: { schemas?: Record<string, object>; responses?: Record<string, ResponseDocument> } }
const documents: Record<IntegrationService, Document> = { course, community };
const ajv = new Ajv2020({ strict: false, coerceTypes: false, removeAdditional: false, useDefaults: false });
addFormats(ajv);
const validators = new Map<string, ValidateFunction>();

// A pinned browser boundary rejects undeclared object fields. Explicit map
// schemas retain their declared additionalProperties behavior; no data is
// coerced, defaulted or silently stripped.
function closedObjects(value: unknown, composing = false): unknown {
  if (Array.isArray(value)) return value.map(child => closedObjects(child));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return { ...Object.fromEntries(Object.entries(record).map(([key, child]) => [key,
    key === "allOf" && Array.isArray(child) ? child.map(fragment => closedObjects(fragment, true)) : closedObjects(child)])),
    ...(!composing && !Array.isArray(record.allOf) && record.properties && record.additionalProperties === undefined ? { additionalProperties: false } : {}),
    ...(!composing && Array.isArray(record.allOf) && record.unevaluatedProperties === undefined ? { unevaluatedProperties: false } : {}) };
}

function validator(key: string, schema: object, document: Document): ValidateFunction {
  let result = validators.get(key);
  if (!result) { result = ajv.compile(closedObjects({ ...schema, components: document.components }) as object); validators.set(key, result); }
  return result;
}
export function validateCandidateRequest(service: IntegrationService, path: string, method: CandidateMethod, input: { body?: unknown; query?: object; params?: object }): void {
  const document = documents[service], operation = document.paths[path]?.[method];
  if (!operation) throw new IntegrationServiceError("invalid_request", 400);
  for (const kind of ["query", "path"] as const) {
    const parameters = operation.parameters?.filter(parameter => parameter.in === kind) ?? [];
    const schema = { type: "object", additionalProperties: false, properties: Object.fromEntries(parameters.map(parameter => [parameter.name, parameter.schema ?? {}])), required: parameters.filter(parameter => parameter.required).map(parameter => parameter.name) };
    if (!validator(`${service}:${method}:${path}:${kind}`, schema, document)(kind === "path" ? input.params ?? {} : input.query ?? {})) throw new IntegrationServiceError("invalid_request", 400);
  }
  const body = operation.requestBody?.content["application/json"]?.schema;
  if (body ? !validator(`${service}:${method}:${path}:body`, body, document)(input.body) : input.body !== undefined) throw new IntegrationServiceError("invalid_request", 400);
}
export function validateCandidateResponse(service: IntegrationService, path: string, method: CandidateMethod, status: number, value: unknown): void {
  const document = documents[service];
  let response = document.paths[path]?.[method]?.responses[String(status)];
  if (response?.$ref) {
    const match = /^#\/components\/responses\/([^/]+)$/u.exec(response.$ref);
    response = match ? document.components?.responses?.[match[1]] : undefined;
  }
  const schema = response?.content?.["application/json"]?.schema;
  if (!schema || !validator(`${service}:${method}:${path}:${status}`, schema, document)(value)) throw new ApiContractError();
}
