import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import openapiTS, { astToString } from "openapi-typescript";
import { readContractBundle } from "./api-contract-tools.mjs";

const { documents } = await readContractBundle();
for (const service of ["course", "community", "boundaries"]) {
  const output = resolve(
    import.meta.dirname,
    `../src/lib/api-integration/generated/${service}.d.ts`,
  );
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
