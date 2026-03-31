#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PKG = "package.json";
const PLACEHOLDER = "__MOTION_DEV_TOKEN__";
const token = process.env.MOTION_DEV_TOKEN;

if (!token) {
  console.error("ERROR: MOTION_DEV_TOKEN env var is not set in Vercel");
  process.exit(1);
}

// Inject token
const original = readFileSync(PKG, "utf-8");
const injected = original.replaceAll(PLACEHOLDER, token);

// Validate JSON before writing
try {
  JSON.parse(injected);
} catch (err) {
  console.error("ERROR: Token injection produced invalid JSON:", err.message);
  process.exit(1);
}

writeFileSync(PKG, injected, "utf-8");
console.log("Injected MOTION_DEV_TOKEN into package.json");

// Install with no lockfile generation
try {
  execSync("npm install --no-package-lock", { stdio: "inherit" });
} catch (err) {
  console.error("\n--- npm install failed (exit code: %d) ---", err.status);
  // Log motion specifiers (masked) for debugging
  try {
    const pkg = JSON.parse(readFileSync(PKG, "utf-8"));
    for (const name of ["motion-plus", "motion-studio"]) {
      const spec = pkg.dependencies?.[name] || "NOT FOUND";
      console.error(`  ${name}: ${spec.replace(/token=[^&"]+/, "token=***")}`);
    }
  } catch { /* ignore */ }
  process.exit(1);
}

// Restore placeholder so the token doesn't leak into build cache/artifacts
const current = readFileSync(PKG, "utf-8");
writeFileSync(PKG, current.replaceAll(token, PLACEHOLDER), "utf-8");
