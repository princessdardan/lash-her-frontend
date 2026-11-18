import "server-only";

import { createHmac } from "node:crypto";

const unrelatedKeys = [
  "AUTH_SECRET",
  "NEXTAUTH_SECRET",
  "AUTH_GOOGLE_SECRET",
  "RESEND_API_KEY",
  "SQUARE_ACCESS_TOKEN",
  "GOOGLE_CLIENT_SECRET",
  "CUSTOMER_AUTH_SECRET",
  "CUSTOMER_AUTH_GOOGLE_SECRET",
  "CUSTOMER_AUTH_RESEND_KEY",
  "INTERNAL_SERVICE_JWT_SECRET",
  "INTERNAL_SERVICE_JWT_PREVIOUS_SECRET",
  "COURSE_STRIPE_TAX_SECRET_KEY",
  "COURSE_PURCHASE_RECOVERY_SECRET",
  "COURSE_COMMUNITY_READ_JWT_CURRENT_SECRET",
  "COMMUNITY_READER_JWT_CURRENT_SECRET",
  "COMMUNITY_ENROLLMENT_PUBLISHER_JWT_CURRENT_SECRET",
  "COURSE_PUBLISHER_JWT_CURRENT_SECRET",
];

export function getIntegrationSigningKey(
  currentKey: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const key = environment[currentKey];
  if (
    !key ||
    Buffer.byteLength(key) < 32 ||
    key.trim() !== key ||
    Object.entries(environment).some(
      ([name, value]) =>
        name !== currentKey &&
        value === key &&
        (name.endsWith("_JWT_CURRENT_SECRET") ||
          name.endsWith("_JWT_PREVIOUS_SECRET") ||
          unrelatedKeys.includes(name)),
    ) ||
    environment.INTERNAL_SERVICE_JWT_SECRETS?.split(",").some(
      (secret) => secret.trim() === key,
    )
  ) {
    throw new Error("Integration signing credentials are unavailable");
  }

  return key;
}

export function signIntegrationToken(claims: object, key: string) {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString(
    "base64url",
  );
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${header}.${encoded}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}
