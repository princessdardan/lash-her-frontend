import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
  async redirects() {
    return [
      {
        source: "/homepage",
        destination: "/",
        permanent: true,
      },
      {
        source: "/training",
        destination: "/training-programs",
        permanent: true,
      },
    ];
  },
  async headers() {
    // Baseline security headers applied to every route, including the card-entry
    // checkout page. SAMEORIGIN (not DENY) so the same-origin Sanity Presentation
    // preview can still frame the site while cross-origin clickjacking is blocked.
    // A route-scoped Content-Security-Policy is intentionally left as a follow-up:
    // it must be validated against the Square Web Payments SDK, Sanity, and
    // analytics before enforcing so it does not break checkout at launch.
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
        ],
      },
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "cdn.sanity.io",
        pathname: "/images/**",
      },
    ],
  },
};

export default nextConfig;
