import "server-only";

import { evaluateManualCheckoutReadiness } from "@/lib/shipping/readiness";

export interface ManualProductCheckoutPolicy {
  enabled: boolean;
  cancellationPolicyText: string | null;
  cancellationPolicyVersion: string | null;
  cancellationPolicyTextHash: string | null;
  blockers: string[];
}

export async function loadManualProductCheckoutPolicy(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<ManualProductCheckoutPolicy> {
  if (env.MANUAL_PRODUCT_CHECKOUT_ENABLED !== "true") {
    return disabledPolicy(["manual_checkout_flag_disabled"]);
  }
  const readiness = await evaluateManualCheckoutReadiness({ env, now });
  if (!readiness.ready || !readiness.policy) {
    return disabledPolicy(readiness.blockers);
  }

  return {
    enabled: true,
    cancellationPolicyText: readiness.policy.text,
    cancellationPolicyVersion: readiness.policy.version,
    cancellationPolicyTextHash: readiness.policy.textHash,
    blockers: [],
  };
}

function disabledPolicy(blockers: string[] = []): ManualProductCheckoutPolicy {
  return {
    enabled: false,
    cancellationPolicyText: null,
    cancellationPolicyVersion: null,
    cancellationPolicyTextHash: null,
    blockers,
  };
}
