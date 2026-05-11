import "server-only";

export function getCheckoutDatabaseUrl(): string {
  return assertValue(
    process.env.CHECKOUT_DATABASE_URL ?? process.env.DATABASE_URL,
    "Missing env var: CHECKOUT_DATABASE_URL",
  );
}

export function getHelcimWebhookVerifierToken(): string {
  return assertValue(
    process.env.HELCIM_WEBHOOK_VERIFIER_TOKEN,
    "Missing env var: HELCIM_WEBHOOK_VERIFIER_TOKEN",
  );
}

function assertValue<T>(value: T | undefined, errorMessage: string): T {
  if (value === undefined) {
    throw new Error(errorMessage);
  }

  return value;
}
