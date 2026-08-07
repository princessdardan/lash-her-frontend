import "server-only";

import type { EnabledCourseApiConfig } from "./config";
import {
  parseEntitlementCheckResponse,
  parseEntitlementGrantResponse,
  parseEntitlementRevokeResponse,
  parseReconcileEntitlementsResponse,
  type CheckEntitlementQuery,
  type EntitlementCheckResult,
  type EntitlementGrantResult,
  type EntitlementRevokeResult,
  type GrantEntitlementCommand,
  type ReconcileEntitlementsCommand,
  type ReconcileEntitlementsResult,
  type RevokeEntitlementCommand,
} from "./contracts";
import { createCourseServiceToken, type JwtRuntime } from "./jwt";
import {
  requestCourseApi,
  type CourseApiRequestContext,
  type CourseApiRequestRuntime,
} from "./request";

export interface InternalEntitlementClient {
  grant(
    command: GrantEntitlementCommand,
    context?: CourseApiRequestContext,
  ): Promise<EntitlementGrantResult>;
  revoke(
    command: RevokeEntitlementCommand,
    context?: CourseApiRequestContext,
  ): Promise<EntitlementRevokeResult>;
  check(
    query: CheckEntitlementQuery,
    context?: CourseApiRequestContext,
  ): Promise<EntitlementCheckResult>;
  reconcile(
    command: ReconcileEntitlementsCommand,
    context?: CourseApiRequestContext,
  ): Promise<ReconcileEntitlementsResult>;
}

export interface InternalEntitlementClientRuntime
  extends CourseApiRequestRuntime, JwtRuntime {}

export function createInternalEntitlementClient(
  config: EnabledCourseApiConfig,
  runtime: InternalEntitlementClientRuntime = {},
): InternalEntitlementClient {
  const request = <T>(
    path: string,
    parse: (value: unknown) => T,
    options: {
      body?: unknown;
      method?: "GET" | "POST";
      context?: CourseApiRequestContext;
    } = {},
  ) => {
    const { context, ...requestOptions } = options;
    const requestRuntime: CourseApiRequestRuntime = {
      ...runtime,
    };
    return requestCourseApi({
      config,
      path,
      parse,
      runtime: requestRuntime,
      cache: "no-store",
      token: createCourseServiceToken(config.serviceJwt, runtime),
      ...requestOptions,
      ...context,
    });
  };

  return {
    grant(command, context) {
      return entitlementMutation(
        config,
        runtime,
        "/v1/internal/entitlements/grants",
        command,
        parseEntitlementGrantResponse,
        context,
      );
    },
    revoke(command, context) {
      return entitlementMutation(
        config,
        runtime,
        "/v1/internal/entitlements/revocations",
        command,
        parseEntitlementRevokeResponse,
        context,
      );
    },
    check(query, context) {
      const search = new URLSearchParams({
        userId: query.userId,
        courseId: query.courseId,
      });
      return request(
        `/v1/internal/entitlements?${search.toString()}`,
        parseEntitlementCheckResponse,
        { context },
      );
    },
    reconcile(command, context) {
      return request(
        "/v1/internal/entitlements/reconcile",
        parseReconcileEntitlementsResponse,
        {
          method: "POST",
          body: command,
          context,
        },
      );
    },
  };
}

function entitlementMutation<
  TCommand extends { readonly idempotencyKey: string },
  TResult,
>(
  config: EnabledCourseApiConfig,
  runtime: InternalEntitlementClientRuntime,
  path: string,
  command: TCommand,
  parse: (value: unknown) => TResult,
  context: CourseApiRequestContext | undefined,
): Promise<TResult> {
  const idempotencyKey = command.idempotencyKey;
  const immutableCommand = { ...command, idempotencyKey };
  return requestCourseApi({
    config,
    path,
    method: "POST",
    body: immutableCommand,
    cache: "no-store",
    token: createCourseServiceToken(config.serviceJwt, runtime),
    parse,
    ...context,
    runtime: {
      ...runtime,
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("x-idempotency-key", idempotencyKey);
        return (runtime.fetch ?? fetch)(input, { ...init, headers });
      },
    },
  });
}
