import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import openapiTS, { astToString } from "../tools/api-contract-toolchain/index.mjs";
import { readContractBundle } from "./api-contract-tools.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a directory`);
  return resolve(value);
}
const selectedBundle = option("--bundle");
const { documents } = await readContractBundle(selectedBundle);
const services = ["course", "community", "boundaries"];
if (!selectedBundle) {
  services.push("course-checkout");
  documents["course-checkout"] = JSON.parse(await readFile(
    new URL("../contracts/api-integration/course-checkout.json", import.meta.url), "utf8",
  ));
}
const outputDirectory =
  option("--output") ??
  resolve(import.meta.dirname, "../src/lib/api-integration/generated");
for (const service of services) {
  const output = resolve(outputDirectory, `${service}.d.ts`);
  const generated =
    "// Generated from the pinned integration bundle. Run npm run contracts:generate.\n" +
    astToString(await openapiTS(documents[service], { alphabetize: true }));
  if (process.argv.includes("--check")) {
    if ((await readFile(output, "utf8")) !== generated)
      throw new Error(`Generated contract drift: ${service}`);
  } else {
    await writeFile(output, generated);
  }
}
console.log("Pinned API types verified");
