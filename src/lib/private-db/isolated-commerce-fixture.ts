export function assertIsolatedCommerceFixtureDatabase(env: Readonly<Record<string, string | undefined>>): void {
  const refuse = () => { throw new Error("Commerce enabled E2E seed requires an explicit isolated loopback fixture database"); };
  if (env.COMMERCE_E2E_ENABLED_MODE !== "1" || env.COMMERCE_E2E_ISOLATED_TEST_DATABASE !== "1" ||
    [env.APP_ENV, env.VERCEL_ENV, env.VERCEL_TARGET_ENV, env.NEXT_PUBLIC_SANITY_DATASET].some(value => value === "production") ||
    env.APP_ENV === "staging" || !env.DATABASE_URL || !env.TEST_DATABASE_URL) refuse();
  const parse = (value: string | undefined) => {
    let url: URL;
    try { url = new URL(value!); } catch { return refuse(); }
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !/^\/lash_her_(?:browser_ci|commerce_e2e(?:_[a-z0-9_]{1,48})?)$/u.test(url.pathname) ||
      [...url.searchParams.keys()].some(key => !["sslmode", "application_name", "connect_timeout"].includes(key)) || url.hash) refuse();
    return JSON.stringify([url.hostname, url.port || "5432", url.pathname, url.username]);
  };
  if (parse(env.DATABASE_URL) !== parse(env.TEST_DATABASE_URL)) refuse();
}
