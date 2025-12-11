import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  images: {
    dangerouslyAllowLocalIP: true,
    remotePatterns: [
      {
      protocol: "http",
      hostname: "localhost",
      port: "1337",
      pathname: "/uploads/**/*",
      }
    ],
  },
};

export default nextConfig;
