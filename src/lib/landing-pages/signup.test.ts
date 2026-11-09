import assert from "node:assert/strict";
import test from "node:test";
import { loaders } from "@/data/loaders";
import { processLandingPageSignup } from "./signup";
import { EMAIL_CONSENT_TEXT } from "@/lib/highlevel/contract";
import type { RecordContactPopupInput } from "@/lib/marketing-contact/marketing-contact-store";
import type { TLandingPage } from "@/types";

const page: TLandingPage = {
  _id: "landing.founding",
  title: "Founding Membership",
  slug: "founding-membership",
  heading: "Become a founding member",
  description: "Our new salon is coming.",
};
const input = {
  slug: page.slug,
  email: " Person@Example.COM ",
  marketingConsent: true,
};

function fixture() {
  const records: RecordContactPopupInput[] = [];
  const calls: string[] = [];
  const dependencies = {
    getPage: async (slug: string): Promise<TLandingPage | null> => {
      assert.equal(slug, page.slug);
      calls.push("page");
      return page;
    },
    record: async (data: RecordContactPopupInput) => {
      calls.push("record");
      records.push(data);
    },
    isRateLimited: (email: string) => {
      assert.equal(email, "person@example.com");
      return false;
    },
    notifyAdmin: async () => {
      calls.push("admin");
    },
    sendWelcome: async () => {
      calls.push("welcome");
    },
    logError: (message: string) => {
      assert.ok(message.startsWith("[landing-page]"));
      calls.push("error");
    },
  };
  return { dependencies, records, calls };
}

test("landing signup saves server-resolved campaign identity and explicit email consent before notifications", async () => {
  const { dependencies, records, calls } = fixture();
  const result = await processLandingPageSignup(
    {
      ...input,
      sourcePath: "/fake",
      consentText: "fake",
      landingPage: { id: "fake" },
      signupOffer: { promotionId: "fake" },
      smsMarketingConsent: true,
      attribution: { utm_campaign: " founding ", token: "ignored" },
    },
    dependencies,
  );
  assert.deepEqual(result, { success: true });
  assert.deepEqual(calls, ["page", "record", "admin", "welcome"]);
  assert.deepEqual(records[0], {
    email: "person@example.com",
    variant: "emailOnly",
    marketingConsent: true,
    smsMarketingConsent: false,
    consentText: EMAIL_CONSENT_TEXT,
    sourcePath: "/founding-membership",
    attribution: { utm_campaign: "founding" },
    landingPage: { id: page._id, title: page.title },
  });
});

test("landing signup rejects missing or forged consent and invalid email without side effects", async () => {
  for (const data of [
    { ...input, marketingConsent: false },
    { ...input, marketingConsent: "true" },
    { ...input, email: "bad" },
    { ...input, email: "x".repeat(255) + "@example.com" },
    null,
    [],
    { ...input, slug: "admin" },
    { ...input, slug: "nested/page" },
  ]) {
    const { dependencies, calls } = fixture();
    assert.equal(
      (await processLandingPageSignup(data, dependencies)).success,
      false,
    );
    assert.deepEqual(calls, []);
  }
});

test("missing, unpublished, and stale-slug landing pages cannot collect signups", async () => {
  for (const resolved of [null, { ...page, slug: "renamed" }]) {
    const { dependencies, records } = fixture();
    dependencies.getPage = async () => resolved;
    assert.equal(
      (await processLandingPageSignup(input, dependencies)).success,
      false,
    );
    assert.equal(records.length, 0);
  }
});

test("signup falls back to the published Sanity CDN only when the live API hits its quota", async (t) => {
  for (const { status, cachedPage, expectedHosts, success } of [
    {
      status: 402,
      cachedPage: page,
      expectedHosts: ["api", "apicdn"],
      success: true,
    },
    {
      status: 402,
      cachedPage: null,
      expectedHosts: ["api", "apicdn"],
      success: false,
    },
    { status: 403, cachedPage: page, expectedHosts: ["api"], success: false },
  ]) {
    const hosts: string[] = [];
    const fetchMock = t.mock.method(
      globalThis,
      "fetch",
      async (request: string, options: RequestInit) => {
        const url = new URL(request);
        const host = url.hostname.split(".")[1];
        hosts.push(host);
        assert.equal(url.searchParams.get("perspective"), "published");
        assert.equal(url.searchParams.get("$slug"), JSON.stringify(page.slug));
        assert.equal(options.cache, "no-store");

        return host === "apicdn"
          ? Response.json({ result: cachedPage })
          : Response.json(
              { error: status === 402 ? "plan_limit_reached" : "forbidden" },
              { status },
            );
      },
    );
    const { dependencies, records } = fixture();
    const result = await processLandingPageSignup(input, {
      ...dependencies,
      getPage: loaders.getLandingPageSignupDetails,
    });
    fetchMock.mock.restore();

    assert.deepEqual(hosts, expectedHosts);
    assert.equal(result.success, success);
    assert.equal(records.length, success ? 1 : 0);
  }
});

test("database failure does not send emails or report a saved signup", async () => {
  const { dependencies, calls } = fixture();
  dependencies.record = async () => {
    throw new Error("offline");
  };
  assert.equal(
    (await processLandingPageSignup(input, dependencies)).success,
    false,
  );
  assert.deepEqual(calls, ["page", "error"]);
});

test("email failures preserve a successful private signup", async () => {
  const { dependencies, records } = fixture();
  dependencies.notifyAdmin = dependencies.sendWelcome = async () => {
    throw new Error("offline");
  };
  assert.deepEqual(await processLandingPageSignup(input, dependencies), {
    success: true,
  });
  assert.equal(records.length, 1);
});

test("honeypot and rate-limited requests never write or send", async () => {
  const { dependencies, calls } = fixture();
  assert.deepEqual(
    await processLandingPageSignup({ ...input, company: "bot" }, dependencies),
    { success: true },
  );
  dependencies.isRateLimited = () => true;
  assert.equal(
    (await processLandingPageSignup(input, dependencies)).success,
    false,
  );
  assert.deepEqual(calls, []);
});
