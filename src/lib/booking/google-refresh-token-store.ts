const LEGACY_TOKEN_KEY = "booking:google-refresh-token";

export interface GoogleRefreshTokenStorage {
  get<TData>(key: string): Promise<TData | null>;
  set(key: string, value: string): Promise<unknown>;
}

export interface BookingDeploymentEnvironment {
  readonly [name: string]: string | undefined;
  VERCEL_ENV?: string;
  VERCEL_TARGET_ENV?: string;
}

export async function readGoogleRefreshToken(
  storage: GoogleRefreshTokenStorage,
  environment: BookingDeploymentEnvironment,
): Promise<string | null> {
  const deploymentEnvironment = getBookingDeploymentEnvironment(environment);
  const refreshToken = await storage.get<string>(
    toGoogleRefreshTokenKey(deploymentEnvironment),
  );

  if (refreshToken !== null || deploymentEnvironment !== "production") {
    return refreshToken;
  }

  // The original implementation used one unscoped key. Only production may
  // read it so an existing production connection survives this migration.
  return storage.get<string>(LEGACY_TOKEN_KEY);
}

export async function writeGoogleRefreshToken(
  refreshToken: string,
  storage: GoogleRefreshTokenStorage,
  environment: BookingDeploymentEnvironment,
): Promise<void> {
  await storage.set(
    toGoogleRefreshTokenKey(getBookingDeploymentEnvironment(environment)),
    refreshToken,
  );
}

function getBookingDeploymentEnvironment(
  environment: BookingDeploymentEnvironment,
): string {
  return (
    environment.VERCEL_TARGET_ENV?.trim() ||
    environment.VERCEL_ENV?.trim() ||
    "development"
  ).toLowerCase();
}

function toGoogleRefreshTokenKey(deploymentEnvironment: string): string {
  return `booking:google-refresh-token:${encodeURIComponent(deploymentEnvironment)}`;
}
