const DEFAULT_ACADEMY_BASE_PATH = "/academy";

export interface AcademyConfig {
  basePath: string;
  enabled: boolean;
}

export function getAcademyConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AcademyConfig {
  return {
    basePath: normalizeAcademyBasePath(environment.ACADEMY_BASE_PATH),
    enabled: environment.ACADEMY_ENABLED === "true",
  };
}

export function normalizeAcademyBasePath(value: string | undefined): string {
  // The physical App Router tree is fixed at /academy for this milestone.
  // Ignore overrides until a corresponding rewrite/deployment contract exists.
  void value;
  return DEFAULT_ACADEMY_BASE_PATH;
}
