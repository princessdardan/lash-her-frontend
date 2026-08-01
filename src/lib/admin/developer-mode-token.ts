import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = 1;
const MAX_TOKEN_LENGTH = 2_048;

interface AdminDeveloperTokenPayload {
  expiresAt: number;
  purpose: string;
  value: string;
  version: number;
}

export function createAdminDeveloperToken(input: {
  expiresAt: number;
  purpose: string;
  secret: string;
  value: string;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      expiresAt: input.expiresAt,
      purpose: input.purpose,
      value: input.value,
      version: TOKEN_VERSION,
    } satisfies AdminDeveloperTokenPayload),
  ).toString("base64url");

  return `${payload}.${sign(payload, input.secret)}`;
}

export function verifyAdminDeveloperToken(input: {
  now: number;
  purpose: string;
  secret: string;
  token: string | undefined;
}): string | null {
  if (!input.token || input.token.length > MAX_TOKEN_LENGTH) return null;

  const [payload, signature, unexpected] = input.token.split(".");
  if (!payload || !signature || unexpected !== undefined) return null;

  const expectedSignature = sign(payload, input.secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<AdminDeveloperTokenPayload>;

    if (
      parsed.version !== TOKEN_VERSION ||
      parsed.purpose !== input.purpose ||
      typeof parsed.value !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      parsed.expiresAt <= input.now
    ) {
      return null;
    }

    return parsed.value;
  } catch {
    return null;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
