// Test-only network edge. Real Next handlers and Course authentication/SQL remain
// active. This does not certify Vercel workload verification or any live provider.
"use strict";
if (process.env.COURSE_AUTHORING_BROWSER_FIXTURE === "1") {
  const database = new URL(process.env.DATABASE_URL || "");
  const course = new URL(process.env.COURSE_AUTHORING_API_ORIGIN || "");
  if (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV !== "preview" ||
    database.hostname !== "127.0.0.1" ||
    database.pathname !== "/lash_authoring_frontend_integration" ||
    course.hostname !== "127.0.0.1" ||
    course.protocol !== "http:"
  )
    throw new Error(
      "Authoring fixture requires its owned loopback databases and development server",
    );
  const original = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (url.hostname === "authoring-gateway.invalid") {
      const headers = new Headers(options?.headers);
      if (
        !url.pathname.startsWith("/course/v1/") ||
        headers.get("x-lash-workload-token") !== process.env.VERCEL_OIDC_TOKEN
      )
        throw new Error("Unexpected authoring gateway fixture request");
      return original(
        new URL(`${url.pathname.slice(7)}${url.search}`, course),
        options,
      );
    }
    if (
      url.hostname.endsWith(".api.sanity.io") ||
      url.hostname.endsWith(".apicdn.sanity.io")
    ) {
      const query = url.searchParams.get("query") || "";
      const result = query.includes('"globalSettings"')
        ? {
            title: "Lash Her",
            header: { logoText: { label: "Lash Her", href: "/" } },
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
      url.origin === new URL(process.env.AUTH_URL).origin ||
      url.origin === process.env.COURSE_AUTHORING_FONT_ORIGIN
    )
      return original(input, options);
    throw new Error("Unexpected external request in authoring browser fixture");
  };
}
