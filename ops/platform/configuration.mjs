import routes from "../gateway/routes.json" with { type: "json" };

export function privateTlsPolicies() {
  const operations = ["/health", "/ready", "/metrics"].map((path) => ({ method: "GET", path }));
  const authority = [
    { method: "POST", path: "/v1/internal/community/entitlements/check" },
    { method: "POST", path: "/v1/internal/community/enrollment-streams/resolve" },
    { method: "POST", path: "/v1/internal/community/enrollment-snapshots" },
    { method: "GET", path: "/v1/internal/community/enrollment-snapshots/{snapshotId}" },
    { method: "GET", path: "/v1/internal/community/enrollment-snapshots/{snapshotId}/items" },
  ];
  return {
    course: {
      upstream: "http://course-api:4000", keyFile: "/tls/key.pem", certFile: "/tls/cert.pem",
      peers: [
        { address: "172.29.10.10", routes: routes.filter(route => (route.service ?? "course") === "course").map(({ method, path }) => ({ method, path })) },
        { address: "172.29.10.31", routes: [authority[0]] },
        { address: "172.29.10.32", routes: authority },
        { address: "172.29.10.60", routes: operations },
      ],
    },
    community: {
      upstream: "http://community-api:4100", keyFile: "/tls/key.pem", certFile: "/tls/cert.pem",
      peers: [
        { address: "172.29.10.22", routes: [{ method: "POST", path: "/v1/internal/course/enrollment-events" }] },
        { address: "172.29.10.10", routes: routes.filter(route => route.service === "community").map(({ method, path }) => ({ method, path })) },
        { address: "172.29.10.60", routes: operations },
      ],
    },
  };
}

// These are maximum concurrent connections, not measured active consumption.
// API and worker clients explicitly cap ordinary pools at 10 and readiness at 1.
export const databaseConnectionBudgets = Object.freeze({
  course: { runtimeProcesses: 5, runtimeMaximum: 55, migrationMaximum: 1, requiredLimit: 60 },
  community: { runtimeProcesses: 2, runtimeMaximum: 22, migrationMaximum: 1, requiredLimit: 30 },
});

// Reviewed against Course 11ea33d085e277bf4d9517476b683b5389c8eaa8:
// src/db/client.ts and the two standalone process-env modules. The host release
// owner also enforces these closed env-file scopes before evaluating config.
// PORT/NODE_OPTIONS are supplied by Compose, never by the private env files.
const workerDatabaseKeys = ["NODE_ENV", "DATABASE_TARGET", "STAGING_DATABASE_URL", "PROD_DATABASE_URL"];
export const courseWorkerPolicies = Object.freeze({
  "course-media": Object.freeze({
    port: "4003", command: "dist/mux-media-worker.js", network: "course_media_egress",
    configModule: "dist/config/mux-media-process-env.js", configParser: "parseMuxMediaProcessEnv",
    environmentKeys: Object.freeze([...workerDatabaseKeys, "MUX_TOKEN_ID", "MUX_TOKEN_SECRET", "MUX_ENVIRONMENT_ID",
      "MUX_MEDIA_RECOVERY_ENABLED", "MUX_MEDIA_CLEANUP_ENABLED", "MUX_MEDIA_RECOVERY_POLL_INTERVAL_MS"]),
    disabledFlags: Object.freeze(["MUX_MEDIA_RECOVERY_ENABLED", "MUX_MEDIA_CLEANUP_ENABLED"]),
  }),
  "course-export-cleanup": Object.freeze({
    port: "4004", command: "dist/account-export-cleanup-worker.js", network: "course_export_cleanup_egress",
    configModule: "dist/config/account-export-process-env.js", configParser: "parseAccountExportProcessEnv",
    environmentKeys: Object.freeze([...workerDatabaseKeys, "COURSE_ACCOUNT_EXPORT_CLEANUP_ENABLED", "COURSE_ACCOUNT_EXPORT_CLEANUP_POLL_MS"]),
    disabledFlags: Object.freeze(["COURSE_ACCOUNT_EXPORT_CLEANUP_ENABLED"]),
  }),
});
