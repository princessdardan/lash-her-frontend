import { Redis } from "@upstash/redis";

const projectId = "prj_wvBLVsXzC1XMZ11hSIfBi2bHXsyy";
const runnerUrl = "https://lash-her-production-backup-runner.vercel.app/api/restore";
const occurrenceRetentionSeconds = 8 * 24 * 60 * 60;

type ClaimOccurrence = (scheduledAt: string, executionId: string) => Promise<boolean>;

function createOccurrenceClaim(env: Record<string, string | undefined>): ClaimOccurrence {
  const url = env.KV_REST_API_URL;
  const token = env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Missing backup occurrence storage");
  const redis = new Redis({ url, token });
  return async (scheduledAt, executionId) =>
    (await redis.set(`backup-validation:production:${scheduledAt}`, executionId, {
      nx: true,
      ex: occurrenceRetentionSeconds,
    })) === "OK";
}

export async function runProductionBackupValidation(
  request: Request,
  env: Record<string, string | undefined> = process.env,
  fetchRunner = fetch,
  claimOccurrence?: ClaimOccurrence,
) {
  const secret = env.BACKUP_VALIDATION_RUNNER_SECRET;
  if (secret === undefined) return null;
  if (!/^[a-f0-9]{64}$/.test(secret) || env.APP_ENV !== "production" ||
      env.VERCEL_ENV !== "production" || env.VERCEL_PROJECT_ID !== projectId) {
    throw new Error("Invalid production backup runner binding");
  }

  const executionId = request.headers.get("ce-id");
  const scheduledAt = new Date(request.headers.get("ce-vssscheduledat") ?? "");
  if (!executionId || !/^schx_[A-Z0-9]{10,64}$/.test(executionId) ||
      request.headers.get("ce-source") !== "/schedule/default/backup-validation" ||
      request.headers.get("ce-vssschedulesource") !== "static" ||
      request.headers.get("ce-vssexpression") !== "0 6 * * 1" ||
      scheduledAt.getUTCDay() !== 1 || scheduledAt.getUTCHours() !== 6 ||
      scheduledAt.getUTCMinutes() !== 0 || scheduledAt.getUTCSeconds() !== 0 ||
      scheduledAt.getUTCMilliseconds() !== 0 || scheduledAt.getTime() > Date.now()) {
    throw new Error("Invalid production backup Schedule event");
  }

  const claim = claimOccurrence ?? createOccurrenceClaim(env);
  // Keep the claim even on an uncertain result so the same weekly occurrence
  // cannot start another restore branch after a lost runner response.
  if (!(await claim(scheduledAt.toISOString(), executionId))) {
    return { validationPerformed: false, duplicateScheduleDelivery: true, executionId } as const;
  }

  const response = await fetchRunner(runnerUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "x-backup-execution-id": executionId },
    redirect: "error",
    signal: AbortSignal.timeout(200_000),
  });
  if (!response.ok) throw new Error("Restore runner failed");

  const proof = await response.json();
  const recoveryPointAt = Date.parse(proof?.recoveryPointAt);
  const hasSnapshot = proof?.recoverySource === "snapshot" && typeof proof.snapshot === "string" &&
    /^snap-[a-z0-9-]+$/.test(proof.snapshot);
  const hasPointInTime = proof?.recoverySource === "point_in_time" && proof.snapshot === undefined;
  if (proof?.validationPerformed !== true || proof.provider !== "neon" ||
      proof.executionId !== executionId || proof.sourcePreserved !== true ||
      proof.isolatedRestore !== true || proof.cleanupVerified !== true ||
      proof.schemaMatches !== true || proof.migrationLineageMatches !== true ||
      proof.readOnly !== true || proof.tlsVerified !== true ||
      !Number.isSafeInteger(proof.migrationCount) || proof.migrationCount < 1 ||
      (!hasSnapshot && !hasPointInTime) || !Number.isFinite(recoveryPointAt) || recoveryPointAt >= Date.now()) {
    throw new Error("Restore runner returned incomplete proof");
  }

  return {
    validationPerformed: true,
    manualActionRequired: false,
    provider: "neon",
    executionId,
    recoverySource: hasSnapshot ? "snapshot" : "point_in_time",
    recoveryPointAt: new Date(recoveryPointAt).toISOString(),
    ...(hasSnapshot ? { snapshot: proof.snapshot as string } : {}),
    migrationCount: proof.migrationCount as number,
    sourcePreserved: true,
    isolatedRestore: true,
    schemaMatches: true,
    migrationLineageMatches: true,
    cleanupVerified: true,
    readOnly: true,
    tlsVerified: true,
  } as const;
}
