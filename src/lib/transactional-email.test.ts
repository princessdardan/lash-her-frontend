import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { getEmailProfileImageHtml, sendTransactionalEmail } from "./src/lib/transactional-email.ts";
`;

test("email profile image helper is empty without a configured URL", () => {
  runTransactionalEmailScenario(`
    delete process.env.EMAIL_PROFILE_IMAGE_URL;

    assert.equal(getEmailProfileImageHtml(), "");
  `);
});

test("email profile image helper escapes the configured URL", () => {
  runTransactionalEmailScenario(`
    process.env.EMAIL_PROFILE_IMAGE_URL = " https://assets.lashher.com/nataliea<profile>.jpg?size=72&theme=dark ";

    const html = getEmailProfileImageHtml();

    assert.match(html, /<img/);
    assert.match(html, /width="72"/);
    assert.match(html, /height="72"/);
    assert.match(html, /alt="Lash Her by Nataliea profile picture"/);
    assert.equal(html.includes('src="https://assets.lashher.com/nataliea&lt;profile&gt;.jpg?size=72&amp;theme=dark"'), true);
    assert.equal(html.includes("nataliea<profile>"), false);
  `);
});

test("transactional email sends configured Resend templates without source-rendered HTML", () => {
  runTransactionalEmailScenario(`
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({
        body: JSON.parse(init.body),
        url: String(url),
      });

      return new Response(JSON.stringify({ id: "email_123" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };

    process.env.ADMIN_EMAIL = "admin@lashher.test";
    process.env.FROM_EMAIL = "Lash Her <hello@lashher.test>";
    process.env.RESEND_API_KEY = "re_test";

    const result = await sendTransactionalEmail({
      html: "<p>Fallback HTML</p>",
      subject: "Fallback subject",
      template: {
        id: "template_welcome",
        variables: { CUSTOMER_NAME: "Client Name" },
      },
      to: "client@example.com",
    });

    assert.deepEqual(result, { id: "email_123" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.resend.com/emails");
    assert.equal(requests[0].body.html, undefined);
    assert.equal(requests[0].body.subject, undefined);
    assert.deepEqual(requests[0].body.template, {
      id: "template_welcome",
      variables: { CUSTOMER_NAME: "Client Name" },
    });
    assert.equal(requests[0].body.from, "Lash Her <hello@lashher.test>");
    assert.deepEqual(requests[0].body.to, "client@example.com");
  `);
});

function runTransactionalEmailScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;
  const env = { ...process.env };

  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";
  delete env.EMAIL_PROFILE_IMAGE_URL;

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
    },
  );
}
