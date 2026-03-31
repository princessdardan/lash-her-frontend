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

const original = readFileSync(PKG, "utf-8");
writeFileSync(PKG, original.replaceAll(PLACEHOLDER, token), "utf-8");
console.log("Injected MOTION_DEV_TOKEN into package.json");

execSync("npm install", { stdio: "inherit" });

// Restore placeholder so the token doesn't leak into build cache/artifacts
const current = readFileSync(PKG, "utf-8");
writeFileSync(PKG, current.replaceAll(token, PLACEHOLDER), "utf-8");
