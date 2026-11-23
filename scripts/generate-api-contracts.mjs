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
const bundle = option("--bundle");
const { documents } = await readContractBundle(bundle);
const outputDirectory =
  option("--output") ??
  resolve(import.meta.dirname, "../src/lib/api-integration/generated");
const sourceDocuments = {
  course: documents.course,
  community: documents.community,
  boundaries: documents.boundaries,
};
if (!bundle) {
  const projection = new URL(
    "../contracts/api-integration/course-dispute-resolution.json",
    import.meta.url,
  );
  sourceDocuments["course-dispute-resolution"] = JSON.parse(
    await readFile(projection, "utf8"),
  );
}
for (const [service, document] of Object.entries(sourceDocuments)) {
  const output = resolve(outputDirectory, `${service}.d.ts`);
  const source = service === "course-dispute-resolution"
    ? "the Course dispute resolution projection"
    : "the pinned integration bundle";
  const generated =
    `// Generated from ${source}. Run npm run contracts:generate.\n` +
    astToString(await openapiTS(document, { alphabetize: true }));
  if (process.argv.includes("--check")) {
    if ((await readFile(output, "utf8")) !== generated)
      throw new Error(`Generated contract drift: ${service}`);
  } else {
    await writeFile(output, generated);
  }
}
console.log("Pinned API types verified");
