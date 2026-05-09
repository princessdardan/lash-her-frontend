import { createHash, timingSafeEqual } from "node:crypto";

import type { HelcimPayloadValue } from "./helcim-types";

const SHA256_HEX_LENGTH = 64;
const HEX_PATTERN = /^[0-9a-f]+$/i;

export function createHelcimResponseHash(
  data: Record<string, HelcimPayloadValue>,
  secretToken: string,
): string {
  return createHash("sha256").update(`${JSON.stringify(data)}${secretToken}`).digest("hex");
}

export function validateHelcimResponseHash(
  data: Record<string, HelcimPayloadValue>,
  secretToken: string,
  hash: string,
): boolean {
  if (!isSha256Hex(hash)) {
    return false;
  }

  const expectedHash = createHelcimResponseHash(data, secretToken);
  const expectedBuffer = Buffer.from(expectedHash, "hex");
  const receivedBuffer = Buffer.from(hash, "hex");

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

function isSha256Hex(value: string): boolean {
  return value.length === SHA256_HEX_LENGTH && HEX_PATTERN.test(value);
}
