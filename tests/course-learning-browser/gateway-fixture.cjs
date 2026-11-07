// Test-only network edge. Real Next handlers and Course authentication/SQL remain
// active. This does not certify Vercel workload verification or any live provider.
"use strict";
if (process.env.COURSE_LEARNING_BROWSER_FIXTURE === "1") {
  const { appendFileSync } = process.getBuiltinModule("node:fs");
  const journal = process.env.COURSE_LEARNING_GATEWAY_JOURNAL;
  const database = new URL(process.env.DATABASE_URL || "");
  const course = new URL(process.env.COURSE_LEARNING_API_ORIGIN || "");
  const frontend = new URL(process.env.AUTH_URL || "");
  const mode = process.env.COURSE_LEARNING_BROWSER_MODE;
  const gateway = "https://learning-gateway.invalid";
  if (
    (mode !== "development" && mode !== "production") ||
    process.env.NODE_ENV !== mode ||
    process.env.VERCEL_ENV !== "production" ||
    process.env.API_GATEWAY_STAGING_ORIGIN !== gateway ||
    database.protocol !== "postgresql:" ||
    database.hostname !== "127.0.0.1" ||
    !database.port || database.username !== "postgres" || database.password ||
    database.search !== "?sslmode=disable" || database.hash ||
    database.pathname !== "/lash_learning_frontend_integration" ||
    course.href !== `http://127.0.0.1:${course.port}/` || !course.port ||
    frontend.href !== `${mode === "production" ? "https" : "http"}://localhost:${frontend.port}/` || !frontend.port
  )
    throw new Error(
      "Actual learner fixture requires its owned loopback database, Course and Next server",
    );
  if (mode === "production") {
    // Guard libraries that bypass global fetch, including during build-time rendering.
    const { Socket } = process.getBuiltinModule("node:net");
    const connect = Socket.prototype.connect;
    const ports = new Set([database.port, course.port, frontend.port]);
    Socket.prototype.connect = function (...args) {
      const normalized = Array.isArray(args[0]) ? args[0] : args;
      const first = normalized[0];
      const options = typeof first === "number" ? { port: first, host: normalized[1] } : first;
      if (options?.port !== undefined && (!ports.has(String(options.port)) ||
        !["localhost", "127.0.0.1", "::1"].includes(options.host ?? "localhost")))
        throw new Error("Unexpected outbound socket in owned production learner fixture");
      return connect.apply(this, args);
    };
  }
  const original = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (url.origin === gateway) {
      const headers = new Headers(options?.headers);
      if (
        !url.pathname.startsWith("/course/v1/") ||
        headers.get("x-lash-workload-token") !== process.env.VERCEL_OIDC_TOKEN
      )
        throw new Error("Unexpected actual learner gateway fixture request");
      const response = await original(
        new URL(`${url.pathname.slice(7)}${url.search}`, course),
        { ...options, redirect: "error" },
      );
      if (journal && /^\/course\/v1\/(?:courses\/[a-z0-9-]+|student\/(?:courses\/[0-9a-f-]+(?:\/enrollments)?|lessons\/[0-9a-f-]+(?:\/(?:playback|quiz(?:\/attempts)?))?|progress))$/u.test(url.pathname)) {
        const denial = mode === "production" && response.status === 403 ? {
          requestId: response.headers.get("x-request-id"),
          canonicalDenial: (await response.clone().text()) ===
            '{"error":{"code":"ACTIVE_ENROLLMENT_REQUIRED","message":"Active enrollment required"}}',
        } : {};
        appendFileSync(journal, JSON.stringify({
          method: options?.method ?? "GET", target: url.pathname + url.search, status: response.status, ...denial,
        }) + "\n", { mode: 0o600 });
      }
      return response;
    }
    if (
      url.origin === "https://7o23yrvk.api.sanity.io" ||
      url.origin === "https://7o23yrvk.apicdn.sanity.io"
    ) {
      const query = url.searchParams.get("query") || "";
      const result = query.includes('"globalSettings"')
        ? {
            title: "Lash Her",
            header: {
              logoText: { label: "Lash Her", href: "/" },
              ctaButton: [
                { _key: "book", label: "Book now", href: "/contact" },
              ],
            },
            footer: {
              logoText: { label: "Lash Her", href: "/" },
              navigationMenus: [],
              socialLink: [],
            },
            contactPopup: { enabled: false },
          }
        : query.includes('"mainMenu"')
          ? { items: [] }
          : mode === "production" && !/\]\s*\[0\]/u.test(query)
            ? []
            : null;
      return Response.json(
        { result },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (
      url.origin === course.origin ||
      url.origin === frontend.origin
    )
      return original(input, { ...options, redirect: "error" });
    throw new Error(
      "Unexpected external request in actual learner browser fixture",
    );
  };
}
