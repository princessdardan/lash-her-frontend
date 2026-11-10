import { backfillHighLevel } from "../src/lib/highlevel/backfill";
import { closePrivateDbPool } from "../src/lib/private-db/client";
import { runManualWriterAdmission } from "../src/lib/writer-admission/manual";

const apply = process.argv.includes("--apply");
const allowed = new Set(["--apply", "--dry-run"]);
if (process.argv.slice(2).some((arg) => !allowed.has(arg)))
  throw new Error("Use --dry-run or --apply");
async function main() {
  try {
    const result = await backfillHighLevel(apply, (kind, task) =>
      runManualWriterAdmission(true, kind, task),
    );
    console.info(JSON.stringify(result, null, 2));
  } catch {
    console.error("highlevel_backfill_failed");
    process.exitCode = 1;
  } finally {
    await closePrivateDbPool();
  }
}

void main();
