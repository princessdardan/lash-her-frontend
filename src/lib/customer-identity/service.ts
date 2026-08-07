import "server-only";

import { randomUUID } from "node:crypto";

import { createCustomerIdentityResolver } from "./resolver";
import { createDrizzleCustomerIdentityStore } from "./store";
import type { CustomerIdentityResolutionInput } from "./types";

let resolver: ReturnType<typeof createCustomerIdentityResolver> | null = null;

export async function resolveCustomerIdentity(
  input: CustomerIdentityResolutionInput,
): Promise<string> {
  resolver ??= createCustomerIdentityResolver({
    generateId: randomUUID,
    now: () => new Date(),
    store: createDrizzleCustomerIdentityStore(),
  });

  return resolver.resolve(input);
}
