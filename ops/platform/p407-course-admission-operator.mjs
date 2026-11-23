import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import {
  bootstrapP407CourseAdmission, changeP407CourseAdmission, observeP407CourseAdmission,
  P407_ADMISSION_TARGET, planP407CourseAdmission,
} from "./p407-course-admission.mjs";

const demand = (ok) => {
  if (!ok) throw new Error("P407_ADMISSION_OPERATOR_INPUT_REFUSED");
};

function readReview(filename) {
  demand(path.isAbsolute(filename));
  const file = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(file);
    demand(stat.isFile() && stat.size > 0 && stat.size <= 4096 && (stat.mode & 0o022) === 0);
    const review = JSON.parse(readFileSync(file, "utf8"));
    demand(Object.keys(review).sort().join(",") === "courseId,customerId,expiresAt,orderId,sourceCommit");
    return review;
  } finally { closeSync(file); }
}

function approvalDirectory(directory) {
  demand(path.isAbsolute(directory));
  const stat = lstatSync(directory);
  demand(stat.isDirectory() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid());
}

function receipt(directory, name, value) {
  const fd = openSync(path.join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const parent = openSync(directory, constants.O_DIRECTORY | constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

function migrationClient(raw) {
  const url = new URL(raw ?? "");
  const target = P407_ADMISSION_TARGET;
  demand(url.protocol === "postgresql:" && url.hostname === target.host && url.port === String(target.port) &&
    url.username === target.user && url.pathname === "/" + target.database && url.search === "?sslmode=verify-full" &&
    url.password && !url.hash && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0");
  return new Client({ host: target.host, port: target.port, user: target.user, database: target.database,
    password: decodeURIComponent(url.password), ssl: { rejectUnauthorized: true }, enableChannelBinding: true,
    connectionTimeoutMillis: 6_000, query_timeout: 20_000, application_name: "lash-her-p407-admission-operator" });
}

async function main([mode, filename, confirmation, directory, epoch, operationId, evidenceSha256, ...extra]) {
  const settlement = mode === "recover-reviewed" ? { operationId, evidenceSha256 } : undefined;
  demand(extra.length === 0 && (settlement === undefined
    ? operationId === undefined && evidenceSha256 === undefined
    : operationId !== undefined && evidenceSha256 !== undefined));
  const operation = {
    bootstrap: bootstrapP407CourseAdmission,
    observe: observeP407CourseAdmission,
    checkout: (client, review) => changeP407CourseAdmission(client, review, epoch, "checkout"),
    recovery: (client, review) => changeP407CourseAdmission(client, review, epoch, "recovery"),
    "recover-reviewed": (client, review) => changeP407CourseAdmission(client, review, epoch, "recovery", settlement),
    close: (client, review) => changeP407CourseAdmission(client, review, epoch, "closed"),
  };
  demand(filename && (mode === "plan" || Object.hasOwn(operation, mode)));
  const review = readReview(filename);
  const plan = planP407CourseAdmission(review);
  if (mode === "plan") {
    demand(confirmation === undefined);
    console.log(JSON.stringify(plan));
    return;
  }
  demand(directory && confirmation === `p4-07/${plan.sourceCommit}/${plan.orderId}`);
  demand(mode === "bootstrap" || mode === "observe" ? epoch === undefined : /^[1-9][0-9]{0,17}$/u.test(epoch ?? ""));
  approvalDirectory(directory);
  const client = migrationClient(process.env.P407_ADMISSION_DATABASE_URL);
  const base = { ...plan, mode, expectedEpoch: epoch ?? null, ...(settlement && { settlement }), sharedTrafficAuthorized: false };
  receipt(directory, "admission-started.json", { ...base, startedAt: new Date().toISOString() });
  try {
    await client.connect();
    const state = await operation[mode](client, review);
    const result = { ...base, ...state, status: "P407_ADMISSION_VERIFIED", checkedAt: new Date().toISOString() };
    receipt(directory, "admission-outcome.json", result);
    console.log(JSON.stringify(result));
  } catch {
    receipt(directory, "admission-outcome.json", { ...base, status: "FAILED_REQUIRES_REVIEW" });
    throw new Error("P407_ADMISSION_OPERATION_REQUIRES_REVIEW");
  } finally {
    await client.end();
  }
}

main(process.argv.slice(2)).catch(() => {
  process.stderr.write("P407_ADMISSION_OPERATOR_REFUSED\n");
  process.exitCode = 1;
});
