import { resolve } from "node:path";
import {
  readContractBundle,
  verifySources,
  assertCompatible,
} from "./api-contract-tools.mjs";

const bundleIndex = process.argv.indexOf("--bundle");
const bundleDirectory =
  bundleIndex >= 0 ? process.argv[bundleIndex + 1] : undefined;
if (
  bundleIndex >= 0 &&
  (!bundleDirectory || bundleDirectory.startsWith("--"))
) {
  throw new Error("--bundle requires a pinned bundle directory");
}
const { manifest, documents } = await readContractBundle(
  bundleDirectory ? resolve(bundleDirectory) : undefined,
);
if (process.argv.includes("--release") && manifest.status !== "released") {
  throw new Error(
    "Candidate contracts cannot certify a release; review and pin a released manifest first",
  );
}
const sourcesIndex = process.argv.indexOf("--sources");
if (process.argv.includes("--release") && sourcesIndex < 0) {
  throw new Error(
    "Release verification requires --sources to verify pinned commit bytes",
  );
}
if (sourcesIndex >= 0) {
  const directory = process.argv[sourcesIndex + 1];
  if (!directory || directory.startsWith("--"))
    throw new Error("--sources requires a repository parent directory");
  verifySources(manifest, resolve(directory));
}
const baselineIndex = process.argv.indexOf("--baseline");
if (baselineIndex >= 0) {
  const directory = process.argv[baselineIndex + 1];
  if (!directory || directory.startsWith("--"))
    throw new Error("--baseline requires a pinned bundle directory");
  const baseline = await readContractBundle(resolve(directory));
  if (baseline.manifest.status !== "released")
    throw new Error("Compatibility baseline must be released");
  for (const name of ["course", "community"])
    assertCompatible(baseline.documents[name], documents[name]);
  // Closed versioned identity/event contracts require coordinated version review.
  for (const name of ["enrollmentEvent", "boundaries"]) {
    if (
      JSON.stringify(baseline.documents[name]) !==
      JSON.stringify(documents[name])
    ) {
      throw new Error(
        `Changed versioned boundary requires compatibility review: ${name}`,
      );
    }
  }
} else if (process.argv.includes("--release")) {
  throw new Error(
    "Release compatibility requires an explicit --baseline bundle",
  );
}
console.log(`Integration contract integrity verified (${manifest.status})`);
