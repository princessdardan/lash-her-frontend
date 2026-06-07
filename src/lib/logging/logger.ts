export function log(
  level: "info" | "warn" | "error" | "debug",
  message: string,
  meta?: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({
      level,
      message,
      timestamp: new Date().toISOString(),
      service: "lash-her-frontend",
      environment: process.env.NODE_ENV ?? null,
      requestId: meta?.requestId,
      ...meta,
    }),
  );
}
