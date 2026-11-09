import { frontendMigrationCli } from "./frontend-migration.mjs";
import { verifyPackagedFrontendSource } from "./frontend-image-source.mjs";
import { runP2FrontendReplacementProbeCli } from "./p2-frontend-replacement-probe.mjs";
import { runP2FrontendReplacementAbortCli } from "./p2-frontend-replacement-abort.mjs";
import { runP2FrontendReplacementWrittenCli } from "./p2-frontend-replacement-written.mjs";
import { runP2FrontendReplacementClosedCli } from "./p2-frontend-replacement-closed.mjs";

try {
  const args = process.argv.slice(2);
  const { commit } = verifyPackagedFrontendSource();
  if (args.length === 1 && args[0] === "--observe-replacement-lock") {
    await runP2FrontendReplacementProbeCli(sourceCommit => {
      if (sourceCommit !== commit) throw new Error("FRONTEND_PACKAGED_SOURCE_REFUSED");
    });
  } else if (args[0] === "--abort-replacement") {
    if (args.length !== 1) throw new Error("FRONTEND_PACKAGED_SOURCE_REFUSED");
    await runP2FrontendReplacementAbortCli(commit);
  } else if (args[0] === "--observe-replacement-written") {
    if (args.length !== 1) throw new Error("FRONTEND_PACKAGED_SOURCE_REFUSED");
    await runP2FrontendReplacementWrittenCli(commit);
  } else if (args[0] === "--observe-replacement-closed") {
    if (args.length !== 1) throw new Error("FRONTEND_PACKAGED_SOURCE_REFUSED");
    await runP2FrontendReplacementClosedCli(commit);
  } else {
    await frontendMigrationCli(args, { assertSource: verifyPackagedFrontendSource });
  }
} catch { console.error("FRONTEND_PACKAGED_SOURCE_REFUSED"); process.exitCode = 1; }
