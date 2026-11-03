import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// This is a host fence for the existing Course transport, including requests
// from historical frontend deployments. It does not replace application auth,
// the six feature flags, or the later frontend database writer fence (P2-00).
export function readAdmission(config) {
  let descriptor;
  try {
    descriptor = openSync(config.admission.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > 4096) throw new Error();
    const raw = readFileSync(descriptor);
    if (raw.length > 4096) throw new Error();
    const value = JSON.parse(raw.toString("utf8"));
    if (Object.keys(value).sort().join(",") !== "actionId,candidateSha256,environment,newWork,recovery,releaseId,version" ||
        value.version !== 1 || value.environment !== config.appEnv ||
        value.releaseId !== config.admission.releaseId || value.candidateSha256 !== config.admission.candidateSha256 ||
        typeof value.actionId !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(value.actionId) ||
        typeof value.newWork !== "boolean" || typeof value.recovery !== "boolean") throw new Error();
    return { valid: true, sha256: createHash("sha256").update(raw).digest("hex"), ...value };
  } catch {
    return { valid: false, newWork: false, recovery: false };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

const RECOVERY_ROUTES = new Set([
  "POST /v1/internal/entitlements/grants",
  "POST /v1/internal/entitlements/reconcile",
  "POST /v1/internal/entitlements/revocations",
  "POST /v1/webhooks/mux",
]);

export function admissionClass(route) {
  if (route.method === "GET") return null;
  // Service-authorized durable financial commands and signed media callbacks
  // may recover independently of customer/student/admin authoring writes.
  if (RECOVERY_ROUTES.has(`${route.method} ${route.path}`)) return "recovery";
  return "newWork";
}
