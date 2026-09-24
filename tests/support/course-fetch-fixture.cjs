/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";
const course = require("../fixtures/short-course.json");
const muxCourse = {
  ...course,
  _id: "course-mux-e2e",
  slug: "course-mux-e2e",
  modules: [
    {
      ...course.modules[0],
      video: {
        provider: "mux",
        id: "mux-asset-one",
        playbackId: "courseMuxPublicPlaybackId",
        status: "ready",
        thumbTime: 0,
      },
    },
    course.modules[1],
    ...["preparing", "ready", null].map((status, index) => ({
      ...course.modules[0],
      _key: `unavailable-${index}`,
      title: `Unavailable lesson ${index + 1}`,
      video: {
        provider: "mux",
        id: `mux-unavailable-${index}`,
        playbackId: null,
        status,
        thumbTime: null,
      },
    })),
  ],
};
const originalFetch = globalThis.fetch;

if (process.env.COURSE_E2E_FIXTURE === "1") {
  if (
    process.env.NODE_ENV === "production" ||
    !["127.0.0.1", "localhost"].includes(
      new URL(process.env.DATABASE_URL).hostname,
    )
  )
    throw new Error(
      "Course fixture requires a local test database and development runtime",
    );
  globalThis.fetch = async function courseFixtureFetch(input, init) {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (
      url.hostname.endsWith(".api.sanity.io") ||
      url.hostname.endsWith(".apicdn.sanity.io")
    ) {
      const query = url.searchParams.get("query") || "";
      let result = null;
      if (query.includes('"shortCourse"')) {
        const selector =
          url.searchParams.get("$slug") || url.searchParams.get("$courseId");
        const selected = [course, muxCourse].find(
          (item) => selector === JSON.stringify(item._id),
        );
        if (selected)
          result = query.includes("lesson[]")
            ? selected
            : {
                ...selected,
                modules: selected.modules.map(({ _key, title }) => ({
                  _key,
                  title,
                })),
              };
      } else if (query.includes('"globalSettings"'))
        result = {
          title: "Lash Her",
          header: {
            logoText: { label: "Lash Her", href: "/" },
            ctaButton: [{ _key: "book", label: "Book now", href: "/contact" }],
          },
          footer: {
            logoText: { label: "Lash Her", href: "/" },
            socialLink: [],
            navigationMenus: [],
          },
          contactPopup: { enabled: true, heading: "Unrelated marketing popup" },
        };
      else if (query.includes('"mainMenu"'))
        result = {
          items: [
            {
              _type: "menuDirectLink",
              _key: "course",
              title: "Course",
              url: "/courses/course-e2e",
            },
          ],
        };
      return json({ result, query, ms: 1 });
    }
    if (url.origin === "https://course-redis.example.invalid") {
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : await input.text(),
      );
      return json(
        url.pathname === "/pipeline"
          ? body.map(() => ({ result: [1, 1, 0] }))
          : { result: [1, 1, 0] },
      );
    }
    if (url.hostname === "api.resend.com")
      throw new Error("Course E2E must not send email");
    return originalFetch(input, init);
  };
}

function json(value) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
