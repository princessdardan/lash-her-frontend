import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const stagingDeployment =
  /^lash-her-frontend-staging-[a-z0-9]{9}-dardan-demiris-projects\.vercel\.app$/u;
const routes = "/api/internal/course-purchases/";
const counts = (value) => Number.isSafeInteger(value) && value >= 0;

class QualificationError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

function settings(args, env) {
  const [mode, ...options] = args;
  if (mode !== "recover" && mode !== "reconcile")
    throw new QualificationError("Specify recover or reconcile.");
  const { values } = parseArgs({
    args: options,
    options: {
      origin: { type: "string" },
      ticks: { type: "string" },
      pages: { type: "string" },
      checkpoint: { type: "string" },
    },
  });
  const origin = new URL(values.origin);
  const loopback =
    origin.protocol === "http:" &&
    origin.hostname === "127.0.0.1" &&
    origin.port;
  const isolated =
    origin.protocol === "https:" &&
    !origin.port &&
    stagingDeployment.test(origin.hostname);
  const staging = origin.origin === "https://staging.lashher.com";
  if (
    (!loopback && !staging && !isolated) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new QualificationError(
      "Use a dedicated staging deployment, the staging origin, or an explicit IPv4 loopback port.",
    );

  if (
    mode === "recover"
      ? values.pages || values.checkpoint
      : values.ticks || !values.checkpoint
  )
    throw new QualificationError(
      "Use --ticks for recovery or --checkpoint and optional --pages for reconciliation.",
    );
  const limit = Number(
    mode === "recover" ? (values.ticks ?? "1") : (values.pages ?? "20"),
  );
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > (mode === "recover" ? 10 : 50)
  )
    throw new QualificationError("Limit must be 1–10 ticks or 1–50 pages.");
  const protection = isolated ? env.VERCEL_AUTOMATION_BYPASS_SECRET : undefined;
  return {
    mode,
    origin: origin.origin,
    limit,
    checkpoint: values.checkpoint,
    protection,
  };
}

async function requestPage({
  origin,
  mode,
  secret,
  fetch,
  after,
  signal,
  protection,
}) {
  const url = new URL(routes + mode, origin);
  if (after !== null) url.searchParams.set("after", after);
  const deadline = AbortSignal.timeout(mode === "recover" ? 50_000 : 20_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        ...(protection ? { "x-vercel-protection-bypass": protection } : {}),
      },
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      const status = response.status;
      throw new QualificationError(
        `Endpoint returned HTTP ${status}.`,
        status === 408 || status === 429 || status >= 500,
      );
    }
    const reader = response.body?.getReader();
    const buffer = [];
    let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 128 * 1024) {
            await reader.cancel().catch(() => undefined);
            throw new QualificationError(
              "Endpoint response exceeded the expected size.",
            );
          }
          buffer.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    try {
      return JSON.parse(Buffer.concat(buffer).toString("utf8"));
    } catch {
      throw new QualificationError("Endpoint returned invalid JSON.");
    }
  } catch (error) {
    if (error instanceof QualificationError) throw error;
    throw new QualificationError(
      "Request failed or timed out. Its outcome is unknown.",
      true,
    );
  }
}

function validateReport(value, after) {
  const {
    checkpoint,
    checkedOrders,
    nextCursor,
    mismatchCount,
    adminOverrideCount,
    mismatches,
  } = value ?? {};
  if (
    !counts(checkedOrders) ||
    checkedOrders > 100 ||
    !(checkpoint === null
      ? checkedOrders === 0
      : typeof checkpoint === "string" &&
        Number.isFinite(Date.parse(checkpoint))) ||
    !(
      nextCursor === null ||
      (typeof nextCursor === "string" &&
        uuid.test(nextCursor) &&
        (!after || nextCursor > after) &&
        checkedOrders === 100)
    ) ||
    !counts(mismatchCount) ||
    !counts(adminOverrideCount) ||
    adminOverrideCount > mismatchCount ||
    !Array.isArray(mismatches) ||
    mismatches.length !== Math.min(200, mismatchCount)
  )
    throw new QualificationError(
      "Invalid reconciliation page. The cursor was not advanced.",
    );

  const details = mismatches.map((item) => {
    const { orderId, expectedStatus, actualStatus, mismatchType } = item ?? {};
    if (
      !(
        orderId === null ||
        (typeof orderId === "string" && uuid.test(orderId))
      ) ||
      !["active", "revoked", "missing"].includes(expectedStatus) ||
      !["active", "revoked", "expired", "missing"].includes(actualStatus) ||
      typeof mismatchType !== "string" ||
      !/^[a-z_]{1,40}$/u.test(mismatchType)
    )
      throw new QualificationError(
        "Invalid reconciliation finding. The cursor was not advanced.",
      );
    return { orderId, expectedStatus, actualStatus, mismatchType };
  });
  return {
    checkpoint,
    checkedOrders,
    nextCursor,
    mismatchCount,
    adminOverrideCount,
    mismatches: details,
  };
}

async function commitPage(directory, number, receipt) {
  const temporary = join(directory, `.pending-${randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(receipt) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, `page-${number}.json`));
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function reconcile(config, { sleep, log, signal }) {
  const directory = resolve(config.checkpoint);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, ".running");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new QualificationError(
      "Checkpoint is locked. Verify the prior runner has stopped before clearing an abandoned lock.",
    );
  }
  try {
    await lock.writeFile(String(process.pid) + "\n");
    await lock.close();
    const pages = (await readdir(directory))
      .map((name) => /^page-([1-9][0-9]*)\.json$/u.exec(name)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((left, right) => left - right);
    if (pages.some((page, index) => page !== index + 1))
      throw new QualificationError("Checkpoint page sequence has a gap.");
    let after = null;
    if (pages.length) {
      const previous = JSON.parse(
        await readFile(join(directory, `page-${pages.length}.json`), "utf8"),
      );
      if (previous.origin !== config.origin)
        throw new QualificationError(
          "Checkpoint belongs to a different origin.",
        );
      after = validateReport(previous.report, previous.after).nextCursor;
      if (after === null) {
        log({ mode: "reconcile", status: "complete", pages: pages.length });
        return 0;
      }
    }

    const runSignal = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
    for (let index = 0; index < config.limit; index++) {
      let response;
      let attempts = 0;
      for (;;) {
        runSignal.throwIfAborted();
        attempts++;
        try {
          response = await requestPage({ ...config, after, signal: runSignal });
          break;
        } catch (error) {
          if (!error.retryable || attempts === 3 || runSignal.aborted)
            throw error;
          await sleep(1000 * attempts, runSignal);
        }
      }
      const report = validateReport(response, after);
      const page = pages.length + index + 1;
      await commitPage(directory, page, {
        origin: config.origin,
        after,
        report,
      });
      log({
        mode: "reconcile",
        page,
        attempts,
        checkedOrders: report.checkedOrders,
        mismatchCount: report.mismatchCount,
        adminOverrideCount: report.adminOverrideCount,
        complete: report.nextCursor === null,
      });
      if (report.nextCursor === null) return 0;
      after = report.nextCursor;
    }
    log({ mode: "reconcile", status: "incomplete", reason: "page_limit" });
    return 2;
  } finally {
    await lock.close().catch(() => undefined);
    await rm(lockPath);
  }
}

export async function runQualification(
  args,
  {
    env = process.env,
    fetch = globalThis.fetch,
    wait = (ms, signal) => sleep(ms, undefined, { signal }),
    log = (result) => console.log(JSON.stringify(result)),
    signal = new AbortController().signal,
  } = {},
) {
  let config;
  try {
    config = settings(args, env);
  } catch (error) {
    if (error instanceof QualificationError) throw error;
    throw new QualificationError(
      "Invalid arguments. Supply --origin and the options for the selected mode.",
    );
  }
  const secret = env.COURSE_PURCHASE_RECOVERY_SECRET;
  if (!secret || secret.length < 32)
    throw new QualificationError(
      "Set COURSE_PURCHASE_RECOVERY_SECRET in the runner environment.",
    );
  const request = { ...config, secret, fetch };
  if (config.mode === "reconcile")
    return reconcile(request, { sleep: wait, log, signal });

  let failure = false;
  for (let tick = 1; tick <= config.limit; tick++) {
    const started = performance.now();
    const { completed, failed } =
      (await requestPage({ ...request, after: null, signal })) ?? {};
    if (!counts(completed) || !counts(failed) || completed + failed > 4)
      throw new QualificationError(
        "Invalid recovery result. Its outcome is unknown.",
      );
    log({ mode: "recover", tick, completed, failed });
    failure ||= failed > 0;
    if (tick < config.limit)
      await wait(Math.max(0, 60_000 - (performance.now() - started)), signal);
  }
  return failure ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  try {
    process.exitCode = await runQualification(process.argv.slice(2), {
      signal: controller.signal,
    });
  } catch (error) {
    console.error(
      error instanceof QualificationError
        ? error.message
        : "Qualification interrupted or checkpoint storage failed.",
    );
    process.exitCode = 1;
  }
}
