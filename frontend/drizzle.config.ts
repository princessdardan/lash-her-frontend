import "dotenv/config";

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/lib/private-db/schema.ts",
  dbCredentials: {
    url: process.env.CHECKOUT_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
