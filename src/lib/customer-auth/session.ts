import "server-only";

import { cookies } from "next/headers";
import { customerSessionCookieName, resolveCustomerAuthConfiguration } from "./policy";
import { createCustomerAuthStore } from "./store";

export interface CustomerActor { id: string; email: string; name: string | null }

/** Read only: never call Auth.js session refresh from a Server Component. */
export async function getCustomerActor(): Promise<CustomerActor | null> {
  const configuration = resolveCustomerAuthConfiguration();
  if (!configuration) return null;
  const token = (await cookies()).get(customerSessionCookieName(configuration.secure))?.value;
  if (!token || token.length > 256) return null;
  const record = await createCustomerAuthStore().adapter.getSessionAndUser!(token);
  return record ? { id: record.user.id, email: record.user.email, name: record.user.name ?? null } : null;
}
