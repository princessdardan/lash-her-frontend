import routes from "./routes.json" with { type: "json" };

// Raw request targets are checked before URL parsing can normalize dot segments.
export function matchRoute(method, target) {
  if (typeof target !== "string" || target.length > 4096 ||
      !/^\/course\/[A-Za-z0-9/_-]+(?:\?[^#\s\\]*)?$/u.test(target)) return null;
  const [pathname] = target.split("?", 1);
  if (pathname.includes("//")) return null;
  const path = pathname.slice("/course".length);
  return routes.find((route) => route.method === method &&
    new RegExp(`^${route.path.replace(/\{[^}]+\}/gu, "[A-Za-z0-9_-]+")}$`, "u").test(path)) ?? null;
}

export function validateConfig(config) {
  if (config === null || typeof config !== "object") throw new Error("Gateway configuration required");
  if (config.maintenance !== undefined && typeof config.maintenance !== "boolean") throw new Error("Invalid gateway maintenance mode");
  const { issuer, audience, subject, ownerId, projectId, environment, publicHost, courseOrigin } = config;
  if (typeof issuer !== "string" || !/^https:\/\/oidc\.vercel\.com(?:\/[a-z0-9-]+)?$/u.test(issuer) ||
      typeof audience !== "string" || !/^https:\/\/vercel\.com\/[a-z0-9-]+$/u.test(audience) ||
      typeof subject !== "string" || !/^owner:[a-z0-9-]+:project:[a-z0-9-]+:environment:production$/u.test(subject) ||
      typeof ownerId !== "string" || !/^team_[A-Za-z0-9]+$/u.test(ownerId) ||
      typeof projectId !== "string" || !/^prj_[A-Za-z0-9]+$/u.test(projectId) || environment !== "production" ||
      !["staging", "production"].includes(config.appEnv) ||
      typeof publicHost !== "string" || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::[0-9]+)?$/u.test(publicHost) ||
      typeof courseOrigin !== "string") throw new Error("Invalid gateway identity or origin configuration");
  const upstream = new URL(courseOrigin);
  if (upstream.protocol !== "https:" || upstream.username || upstream.password ||
      upstream.pathname !== "/" || upstream.search || upstream.hash) throw new Error("Private upstream must be an HTTPS origin");
  for (const field of ["tlsKeyFile", "tlsCertFile", "upstreamCaFile"]) {
    if (typeof config[field] !== "string" || !config[field].startsWith("/")) throw new Error("TLS files must use absolute paths");
  }
  return Object.freeze({ ...config });
}

export class MinuteBudget {
  #windows = new Map();
  constructor(limits, now = Date.now) {
    this.limits = limits;
    this.now = now;
  }
  consume(key) {
    if (!Object.hasOwn(this.limits, key)) throw new Error("Unknown budget");
    const now = this.now();
    let entry = this.#windows.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + 60_000 };
      this.#windows.set(key, entry);
    }
    entry.count++;
    return entry.count <= this.limits[key] ? 0 : Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }
}
