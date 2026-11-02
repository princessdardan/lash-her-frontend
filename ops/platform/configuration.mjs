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
        { address: "172.29.10.10", routes: routes.map(({ method, path }) => ({ method, path })) },
        { address: "172.29.10.31", routes: [authority[0]] },
        { address: "172.29.10.32", routes: authority },
        { address: "172.29.10.60", routes: operations },
      ],
    },
    community: {
      upstream: "http://community-api:4100", keyFile: "/tls/key.pem", certFile: "/tls/cert.pem",
      peers: [
        { address: "172.29.10.22", routes: [{ method: "POST", path: "/v1/internal/course/enrollment-events" }] },
        { address: "172.29.10.60", routes: operations },
      ],
    },
  };
}

// These are maximum concurrent connections, not measured active consumption.
// API and worker clients explicitly cap ordinary pools at 10 and readiness at 1.
export const databaseConnectionBudgets = Object.freeze({
  course: { runtimeProcesses: 3, runtimeMaximum: 33, migrationMaximum: 1, requiredLimit: 40 },
  community: { runtimeProcesses: 2, runtimeMaximum: 22, migrationMaximum: 1, requiredLimit: 30 },
});
