import "server-only";

import { AuthError } from "@auth/core/errors";
import { customFetch } from "next-auth";
import { currentWriterOperationIdentity, markWriterOperationUncertain } from "./context";

function isSettledGoogleCallbackError(error: Error, grantRequested: boolean) {
  if (!(error instanceof AuthError)) return false;
  if (error.type === "InvalidCheck" || error.type === "InvalidCallbackUrl" || error.type === "MissingCSRF" ||
    error.type === "OAuthAccountNotLinked" || error.type === "AccountNotLinked") return true;
  // The customer adapter classifies its own mutations, including explicit
  // selection denials. Auth.js uses AdapterError for both results.
  if (error.type === "AdapterError") return true;
  // Auth.js also uses AccessDenied for an exception thrown by signIn.
  if (error.type === "AccessDenied") return !error.cause?.err;
  if (error.type === "OAuthCallbackError") return !grantRequested;
  if (error.type !== "CallbackRouteError") return false;
  const cause = error.cause?.err as (Error & { code?: unknown; status?: unknown; error?: unknown }) | undefined;
  // The pinned oauth4webapi uses this code for invalid callback parameters
  // (including mismatched state), invalid discovery metadata and malformed
  // token responses. Discovery errors carry a body rather than URL parameters.
  if (!grantRequested) {
    const details = cause?.cause;
    return cause?.code === "OAUTH_INVALID_RESPONSE" &&
      !(details && typeof details === "object" && "body" in details);
  }
  return cause?.code === "OAUTH_RESPONSE_BODY_ERROR" && (cause.status === 400 || cause.status === 401) &&
    (cause.error === "invalid_grant" || cause.error === "invalid_client" || cause.error === "invalid_request" ||
      cause.error === "unauthorized_client" || cause.error === "unsupported_grant_type" || cause.error === "invalid_scope");
}

export function createGoogleCallbackAdmission(isGoogleCallback: boolean) {
  if (!isGoogleCallback || !currentWriterOperationIdentity()) return undefined;
  let grantRequested = false;
  return {
    providerOptions: {
      [customFetch](...args: Parameters<typeof fetch>) {
        if (args[1]?.method === "POST") grantRequested = true;
        return fetch(...args);
      },
    },
    recordError(error: Error) {
      // Auth.js can turn a callback failure into either a redirect or a 200
      // containing a redirect. Set the receipt before that response leaves.
      if (isSettledGoogleCallbackError(error, grantRequested)) return false;
      markWriterOperationUncertain();
      return true;
    },
  };
}
