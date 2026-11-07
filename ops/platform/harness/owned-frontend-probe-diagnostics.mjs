// Fixed diagnostic vocabulary for the disposable fixture only. Never retain
// exception messages, stacks, request bodies, URLs or environment values.
const phases = new Set([
  "configuration", "configuration-import-application-environment", "configuration-import-bootstrap-controls",
  "configuration-read-owned-ca", "configuration-operator-connect", "configuration-read-admission-control",
  "configuration-close-admission", "configuration-import-protected-route", "configuration-start-loopback",
  "actual-protected-route", "initial-http-status", "initial-probe-binding", "auth-and-mode-refusal",
  "feature-control-refusal", "open-ledger-and-source-refusal", "read-only-postconditions",
]);
const modules = ["ops/gateway/routes.json", "ops/gateway/assessment-attempt.mjs", "contracts/api-integration/v1/course-api.json", "contracts/api-integration/v1/community-api.json",
  "contracts/api-integration/p2-candidate/course-api.json", "contracts/api-integration/p2-candidate/community-api.json"];
const transportCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "EACCES", "EPERM", "EPROTO",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]);
const postgresCodes = new Set(["08001", "08006", "28000", "28P01", "3D000", "42501", "42P01", "53300", "57P01", "55P03", "40001"]);

export function safeOwnedBootstrapFailure(phase, error) {
  let failureCode = "UNCLASSIFIED_FIXTURE_FAILURE", dependency;
  if (["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_UNSUPPORTED_DIR_IMPORT"].includes(error?.code)) {
    failureCode = "MODULE_RESOLUTION_FAILED";
    dependency = modules.find(path => typeof error.message === "string" && error.message.includes(path));
  } else if (error?.code === "ERR_ASSERTION") failureCode = "FIXTURE_ASSERTION_FAILED";
  else if (error?.code === "ENOENT") failureCode = "FIXTURE_FILE_UNAVAILABLE";
  else if (transportCodes.has(error?.code)) failureCode = "OWNED_CONNECTION_FAILED";
  else if (postgresCodes.has(error?.code)) failureCode = "OWNED_POSTGRES_REFUSED";
  return { status: "FRONTEND_BOOTSTRAP_PROBE_OWNED_FAILED", phase: phases.has(phase) ? phase : "unknown-phase",
    failureCode, ...(dependency ? { dependency } : {}), providerTouched: false };
}
