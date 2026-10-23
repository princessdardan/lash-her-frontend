import "server-only";

import {
  assertProviderEnvironment,
  resolveApplicationEnvironment,
} from "@/lib/env/application-environment.mjs";

export function getApplicationEnvironment() {
  return resolveApplicationEnvironment(process.env);
}

export function assertApplicationProviderEnvironment(
  name: string,
  value: string | undefined,
  values: { production: string; staging: string },
) {
  assertProviderEnvironment(name, value, values, process.env);
}
