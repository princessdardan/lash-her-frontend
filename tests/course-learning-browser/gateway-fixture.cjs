// Test-only network edge. Real Next handlers and Course authentication/SQL remain
// active. This does not certify Vercel workload verification or any live provider.
"use strict";
if (process.env.COURSE_LEARNING_BROWSER_FIXTURE === "1") {
  const { appendFileSync } = require("node:fs");
  const journal = process.env.COURSE_LEARNING_GATEWAY_JOURNAL;
  const database = new URL(process.env.DATABASE_URL || "");
  const course = new URL(process.env.COURSE_LEARNING_API_ORIGIN || "");
  if (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV !== "production" ||
    database.hostname !== "127.0.0.1" ||
    database.pathname !== "/lash_learning_frontend_integration" ||
    course.hostname !== "127.0.0.1" ||
    course.protocol !== "http:"
  )
    throw new Error(
      "Actual learner fixture requires its owned loopback databases and development server",
    );
  const original = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (url.hostname === "learning-gateway.invalid") {
      const headers = new Headers(options?.headers);
      if (
        !url.pathname.startsWith("/course/v1/") ||
        headers.get("x-lash-workload-token") !== process.env.VERCEL_OIDC_TOKEN
      )
        throw new Error("Unexpected actual learner gateway fixture request");
      const response = await original(
        new URL(`${url.pathname.slice(7)}${url.search}`, course),
        options,
      );
      if (journal && /^\/course\/v1\/(?:courses\/[a-z0-9-]+|student\/(?:courses\/[0-9a-f-]+(?:\/enrollments)?|progress))$/u.test(url.pathname)) {
        appendFileSync(journal, JSON.stringify({
          method: options?.method ?? "GET", target: url.pathname + url.search, status: response.status,
        }) + "\n", { mode: 0o600 });
      }
      return response;
    }
    if (
      url.hostname.endsWith(".api.sanity.io") ||
      url.hostname.endsWith(".apicdn.sanity.io")
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
          : null;
      return Response.json(
        { result },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (
      url.origin === course.origin ||
      url.origin === new URL(process.env.AUTH_URL).origin
    )
      return original(input, options);
    throw new Error(
      "Unexpected external request in actual learner browser fixture",
    );
  };
}
