import { backfillHighLevel } from "../src/lib/highlevel/backfill";
import { closePrivateDbPool } from "../src/lib/private-db/client";

const apply = process.argv.includes("--apply");
const source = process.argv.includes("--course-signups-only")
  ? "course_signup"
  : undefined;
const allowed = new Set(["--apply", "--dry-run", "--course-signups-only"]);
if (process.argv.slice(2).some((arg) => !allowed.has(arg)))
  throw new Error("Use --dry-run or --apply, optionally --course-signups-only");
async function main() {
  try {
    console.info(
      JSON.stringify(await backfillHighLevel(apply, source), null, 2),
    );
  } catch {
    console.error("highlevel_backfill_failed");
    process.exitCode = 1;
  } finally {
    await closePrivateDbPool();
  }
}

void main();
