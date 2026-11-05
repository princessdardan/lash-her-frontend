import { constants, existsSync, fstatSync, fsyncSync, openSync, closeSync, readFileSync, lstatSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeFrontendReceipt } from "./frontend-migration.mjs";

const demand = ok => { if (!ok) throw new Error("FRONTEND_RELEASE_RECEIPTS_REFUSED"); };
export function frontendPrivateReceiptDirectory(directory, empty = false) {
  demand(typeof directory === "string" && resolve(directory) === directory);
  const info = lstatSync(directory);
  demand(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0 && realpathSync(directory) === directory);
  for (let parent = directory;; parent = dirname(parent)) {
    demand(!existsSync(join(parent, ".git")));
    if (dirname(parent) === parent) break;
  }
  demand(!empty || readdirSync(directory).length === 0);
  return directory;
}

export function frontendReleaseReceiptStore(directory) {
  frontendPrivateReceiptDirectory(directory, true);
  return {
    record(name, value) {
      demand(/^[a-z0-9][a-z0-9.-]{0,180}\.json$/u.test(name));
      frontendPrivateReceiptDirectory(directory); writeFrontendReceipt(directory, name, value);
    },
    retain(name, bytes) {
      demand(/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/u.test(name) && Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 2_000_000);
      frontendPrivateReceiptDirectory(directory);
      const fd = openSync(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(fd, bytes); fsyncSync(fd);
        const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { fsyncSync(parent); } finally { closeSync(parent); }
      } finally { closeSync(fd); }
      // A failed durability check leaves exclusive partial evidence; it never
      // authorizes SQL or an overwrite/retry in this action directory.
    },
  };
}

export function readFrontendReleaseEvidence(directory, name) {
  frontendPrivateReceiptDirectory(directory);
  demand(typeof name === "string" && /^[a-z0-9][a-z0-9.-]{0,180}\.json$/u.test(name));
  const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd); demand(info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0 && info.size > 0 && info.size <= 2_000_000);
    const bytes = readFileSync(fd); demand(bytes.length === info.size && bytes.length <= 2_000_000); return bytes;
  } finally { closeSync(fd); }
}
