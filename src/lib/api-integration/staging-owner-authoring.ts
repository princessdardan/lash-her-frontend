import "server-only";

import { randomUUID } from "node:crypto";
import { requireStagingOwnerCourseReader } from "@/lib/admin/auth";
import { stagingOwnerRequest } from "@/lib/admin/staging-owner-auth";
import {
  ownerAuthoringPhase,
  ownerAuthoringSignature,
} from "../../../ops/gateway/staging-owner-authoring.mjs";
import { IntegrationServiceError } from "./service-errors";

const allowedOperations = {
  "create-course": ["POST", "/v1/admin/courses"],
  "create-module": ["POST", "/v1/admin/courses/{courseId}/modules"],
  "create-lesson": ["POST", "/v1/admin/modules/{moduleId}/lessons"],
  "update-lesson": ["PATCH", "/v1/admin/lessons/{lessonId}"],
} as const;

export async function stagingOwnerAuthoring(operation: string, body: unknown) {
  if (!Object.hasOwn(allowedOperations, operation)) return undefined;
  const [method, route] = allowedOperations[operation as keyof typeof allowedOperations];
  const now = Math.floor(Date.now() / 1000);
  const deadline = process.env.STAGING_OWNER_AUTHORING_UNTIL ?? "";
  const end = Number(deadline);
  const key = process.env.STAGING_OWNER_AUTHORING_KEY ?? "";
  if (!/^\d{10}$/u.test(deadline) || end <= now || end > now + 5400 ||
      !/^[a-f0-9]{64}$/u.test(key) || !await stagingOwnerRequest()) return undefined;

  if (ownerAuthoringPhase(method, route, body) < 0)
    throw new IntegrationServiceError("forbidden", 403);
  const owner = await requireStagingOwnerCourseReader();
  return {
    owner,
    prove(input: { method: string; route: string; path: string; body: unknown; token: string }) {
      const expires = Math.min(Math.floor(Date.now() / 1000) + 35, end);
      if (input.method !== method || input.route !== route || ownerAuthoringPhase(method, route, input.body) < 0 ||
          expires <= Math.floor(Date.now() / 1000)) throw new IntegrationServiceError("forbidden", 403);
      const nonce = randomUUID();
      const signature = ownerAuthoringSignature(key, {
        method, target: "/course" + input.path, body: JSON.stringify(input.body), token: input.token, expires, nonce,
      });
      return `1.${expires}.${nonce}.${signature}`;
    },
  };
}

export type StagingOwnerAuthoring = NonNullable<Awaited<ReturnType<typeof stagingOwnerAuthoring>>>;
