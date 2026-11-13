import { writeFile } from "node:fs/promises";

import { loaders } from "../src/data/loaders";

async function main() {
  const [file, ...extra] = process.argv.slice(2);
  if (!file || extra.length) throw new Error("Usage: tsx scripts/export-staging-legacy-courses.ts <new-export.json>");
  const snapshot = await loaders.getLegacyShortCourseMigrationExport();
  const payload = JSON.stringify(snapshot, null, 2) + "\n";
  if (Buffer.byteLength(payload) > 32 * 1024 * 1024) throw new Error("Legacy export exceeds the import size limit");
  await writeFile(file, payload, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ count: snapshot.count, source: snapshot.source }));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Legacy course export failed");
  process.exitCode = 1;
});
