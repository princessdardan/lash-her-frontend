import "server-only";

import { randomUUID } from "node:crypto";
import { getIntegrationSigningKey, signIntegrationToken } from "@/lib/api-integration/integration-token";

export function mintCourseEntitlementToken(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const key = getIntegrationSigningKey("INTERNAL_SERVICE_JWT_SECRET", environment);
  const iat = Math.floor(Date.now() / 1000);
  return signIntegrationToken(
    {
      iss: "lash-her-frontend",
      aud: "lash-her-course-api",
      sub: "frontend",
      iat,
      exp: iat + 300,
      jti: randomUUID(),
    },
    key,
  );
}
