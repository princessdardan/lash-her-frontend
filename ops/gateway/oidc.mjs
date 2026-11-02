import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

export function createWorkloadVerifier(config, options = {}) {
  const keys = createRemoteJWKSet(new URL(`${config.issuer}/.well-known/jwks`), {
    cacheMaxAge: 300_000,
    cooldownDuration: 30_000,
    timeoutDuration: 2000,
    // Dependency injection is for isolated tests; production uses native fetch.
    ...(options.fetch ? { [customFetch]: options.fetch } : {}),
  });
  return async (token) => {
    if (typeof token !== "string" || token.length > 16_384) throw new Error("Invalid workload proof");
    const { payload, protectedHeader } = await jwtVerify(token, keys, {
      algorithms: ["RS256"],
      issuer: config.issuer,
      audience: config.audience,
      subject: config.subject,
      requiredClaims: ["iss", "aud", "sub", "owner_id", "project_id", "environment", "iat", "nbf", "exp"],
      clockTolerance: 5,
      maxTokenAge: 7200,
      ...(options.currentDate ? { currentDate: options.currentDate() } : {}),
    });
    if (typeof protectedHeader.kid !== "string" || !protectedHeader.kid ||
        payload.aud !== config.audience || payload.owner_id !== config.ownerId ||
        payload.project_id !== config.projectId || payload.environment !== config.environment ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.nbf) || !Number.isSafeInteger(payload.exp) ||
        payload.exp <= payload.iat || payload.exp - payload.iat > 7200 ||
        payload.nbf < payload.iat - 5 || payload.nbf >= payload.exp) throw new Error("Invalid workload claims");
    return { projectId: payload.project_id };
  };
}
