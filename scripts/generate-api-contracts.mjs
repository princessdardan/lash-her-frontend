import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import openapiTS, { astToString } from "openapi-typescript";
import { readContractBundle } from "./api-contract-tools.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a directory`);
  return resolve(value);
}
const { documents } = await readContractBundle(option("--bundle"));
const outputDirectory =
  option("--output") ??
  resolve(import.meta.dirname, "../src/lib/api-integration/generated");
for (const service of ["course", "community", "boundaries"]) {
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
