// Fixed public staging origin. Provider observations remain source-parent authority.
import { isDeepStrictEqual } from "node:util";

export const P2_CANONICAL_BROWSER_ORIGIN = "https://staging.lashher.com";
export const P2_CANONICAL_BROWSER_HOST = "staging.lashher.com";
const demand = value => { if (!value) throw new Error("P2_CANONICAL_BROWSER_ORIGIN_REFUSED"); };
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export function validateP2CanonicalBrowserObservation(plan, value) {
  demand(plan?.environment === "staging" && value?.version === 1 && value.status === "P2_CANONICAL_BROWSER_ORIGIN_VERIFIED"
    && value.environment === "staging" && value.browserOrigin === P2_CANONICAL_BROWSER_ORIGIN
    && value.projectId === "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" && value.deploymentId === plan.deploymentId
    && value.deploymentUrl === plan.deploymentUrl && /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(value.deploymentUrl)
    && value.sourceCommit === plan.sourceCommit && value.releaseId === (plan.releaseId ?? plan.actionId)
    && value.configurationRecordSha256 === plan.configurationRecordSha256
    && isDeepStrictEqual(value.featureControls, plan.featureControls) && isDeepStrictEqual(value.writerAdmissionBinding, plan.writerAdmissionBinding)
    && sha(value.aliasReadbackSha256) && sha(value.protectedWorkloadSha256) && Number.isFinite(Date.parse(value.observedAt))
    && value.aliasReadbacks === 2 && value.aliasRedirect === false && value.workloadChallengeVerified === true
    && value.tlsVerified === true && value.probeExpiryExtended === false && value.releaseAccepted === false);
  return value;
}
