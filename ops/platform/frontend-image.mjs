import { frontendMigrationCli } from "./frontend-migration.mjs";
import { verifyPackagedFrontendSource } from "./frontend-image-source.mjs";

try {
  verifyPackagedFrontendSource();
  await frontendMigrationCli(process.argv.slice(2), { assertSource: verifyPackagedFrontendSource });
} catch { console.error("FRONTEND_PACKAGED_SOURCE_REFUSED"); process.exitCode = 1; }
