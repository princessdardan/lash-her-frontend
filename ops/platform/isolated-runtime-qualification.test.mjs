import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./qualify-isolated-runtime.sh", import.meta.url));

for (const [prewarm, verify] of [[0, 0], [0, 13], [19, 0]]) {
  test(`reference worker is isolated and removed with prewarm=${prewarm}, verify=${verify}`, t => {
    const tmp = mkdtempSync(join(tmpdir(), "isolated-runtime-test-"));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const log = join(tmp, "calls");
    writeFileSync(join(tmp, "docker"), `#!/bin/bash
printf 'docker %s\n' "$*" >> "$CALLS"
if [[ "$2" == create ]]; then echo clean-reference-builder; fi
`, { mode: 0o755 });
    writeFileSync(join(tmp, "node"), `#!/bin/bash
printf 'node %s %s\n' "$BUILDX_BUILDER" "${"$"}{1##*/}" >> "$CALLS"
if [[ "$1" == *prewarm-candidate-runtime.mjs ]]; then exit "$PREWARM"; fi
exit "$VERIFY"
`, { mode: 0o755 });
    const result = spawnSync("bash", [helper, "migration", "/source", "a".repeat(40), "/cache", "node", "verify.mjs"],
      { env: { ...process.env, PATH: tmp + delimiter + process.env.PATH, CALLS: log,
        BUILDX_BUILDER: "existing-publisher", PREWARM: String(prewarm), VERIFY: String(verify) }, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, prewarm || verify, result.stderr);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "docker buildx create --driver docker-container --driver-opt default-load=true",
      "node clean-reference-builder prewarm-candidate-runtime.mjs",
      ...(prewarm ? [] : ["node clean-reference-builder verify.mjs"]),
      "docker buildx rm clean-reference-builder",
    ]);
  });
}
