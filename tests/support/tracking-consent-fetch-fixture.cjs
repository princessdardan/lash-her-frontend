/* eslint-disable @typescript-eslint/no-require-imports */
// Deterministic editorial reads; no operational DB, CRM, payment, or email calls.
"use strict";
if (process.env.TRACKING_CONSENT_E2E === "1") {
  if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL)
    throw new Error(
      "Tracking consent fixture requires development and a disabled database",
    );
  const course = require("../fixtures/short-course.json");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function trackingConsentFetch(input, init) {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (
      url.hostname.endsWith(".api.sanity.io") ||
      url.hostname.endsWith(".apicdn.sanity.io")
    ) {
      const query = url.searchParams.get("query") || "";
      let result = null;
      if (query.includes('"globalSettings"'))
        result = {
          title: "Lash Her",
          header: {
            logoText: { label: "Lash Her", href: "/" },
            ctaButton: [
              { _key: "contact", label: "Contact", href: "/contact" },
            ],
          },
          footer: {
            logoText: { label: "Lash Her", href: "/" },
            socialLink: [],
            navigationMenus: [],
          },
          contactPopup: { enabled: false },
        };
      else if (query.includes('"mainMenu"'))
        result = {
          items: [
            { _type: "menuDirectLink", _key: "home", title: "Home", url: "/" },
            {
              _type: "menuDirectLink",
              _key: "gallery",
              title: "Gallery",
              url: "/gallery",
            },
            {
              _type: "menuDirectLink",
              _key: "contact",
              title: "Contact",
              url: "/contact",
            },
          ],
        };
      else if (query.includes('"homePage"') || query.includes('"galleryPage"'))
        result = { title: "Lash Her", blocks: [] };
      else if (query.includes('"contactPage"'))
        result = {
          title: "Contact",
          blocks: [
            {
              _type: "generalInquiryLabels",
              _key: "inquiry",
              heading: "General inquiry",
              name: "Name",
              email: "Email",
              phone: "Phone",
              instagram: "Instagram",
              message: "Message",
            },
          ],
        };
      else if (query.includes('"shortCourse"'))
        result = {
          ...course,
          modules: course.modules.map(({ _key, title }) => ({ _key, title })),
        };
      else if (
        query.includes('"policyPage"') &&
        query.includes("defined(slug.current)")
      ) {
        result = [{ slug: "privacy" }, { slug: "cookie" }];
      } else if (query.includes('"policyPage"')) {
        const slug = JSON.parse(url.searchParams.get("$slug") || '"privacy"');
        result = {
          _id: "policy",
          title: slug === "privacy" ? "Privacy" : "Cookies",
          pageType: slug === "privacy" ? "privacy" : "cookie",
          body: [],
          slug,
        };
      } else if (query.includes('"product"') || query.includes('"service"'))
        result = [];
      return new Response(JSON.stringify({ result, query, ms: 1 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (["127.0.0.1", "localhost"].includes(url.hostname))
      return originalFetch(input, init);
    throw new Error("Tracking consent fixture blocks external service calls");
  };
}
