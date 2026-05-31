import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { getEmailProfileImageHtml } from "./src/lib/transactional-email.ts";
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
