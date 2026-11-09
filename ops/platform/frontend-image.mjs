import { frontendMigrationCli } from "./frontend-migration.mjs";
import { verifyPackagedFrontendSource } from "./frontend-image-source.mjs";
import { runP2FrontendReplacementProbeCli } from "./p2-frontend-replacement-probe.mjs";

try {
  const args = process.argv.slice(2);
  const { commit } = verifyPackagedFrontendSource();
  if (args.length === 1 && args[0] === "--observe-replacement-lock") {
    await runP2FrontendReplacementProbeCli(sourceCommit => {
      if (sourceCommit !== commit) throw new Error("FRONTEND_PACKAGED_SOURCE_REFUSED");
    });
  } else {
    await frontendMigrationCli(args, { assertSource: verifyPackagedFrontendSource });
  }
} catch { console.error("FRONTEND_PACKAGED_SOURCE_REFUSED"); process.exitCode = 1; }
