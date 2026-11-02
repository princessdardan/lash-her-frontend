import assert from "node:assert/strict";
import test from "node:test";
import { localImageId } from "./local-images.mjs";
const id = `sha256:${"1".repeat(64)}`, digest = `sha256:${"2".repeat(64)}`;
const line = (value) => JSON.stringify(value);

test("local image aliases resolve the runnable index ID without inspecting platform manifests", () => {
  const result = localImageId((command, args) => {
    assert.equal(command, "docker");
    assert.ok(args.includes("--no-trunc") && args.includes("reference=lash-her-gateway:p1-local"));
    return line({ Repository: "lash-her-gateway", Tag: "p1-local", Digest: "<none>", ID: id });
  }, "lash-her-gateway:p1-local");
  assert.equal(result, id);
});

test("registry references select the exact published digest, independent of mutable aliases", () => {
  const repository = "ghcr.io/princessdardan/lash-her-platform-gateway";
  const listing = [line({ Repository: repository, Tag: "old", Digest: id, ID: id }),
    line({ Repository: repository, Tag: "candidate", Digest: digest, ID: digest })].join("\n");
  assert.equal(localImageId(() => listing, `${repository}@${digest}`), digest);
  assert.throws(() => localImageId(() => listing, `${repository}@sha256:${"3".repeat(64)}`));
});

test("missing, ambiguous and malformed cached identities refuse", () => {
  const reference = "lash-her-gateway:p1-local";
  for (const records of [[], [{ ID: "truncated" }], [{ ID: id }, { ID: digest }], [{ ID: `sha256:${"0".repeat(64)}` }]]) {
    const listing = records.map((record) => line({ Repository: "lash-her-gateway", Tag: "p1-local", ...record })).join("\n");
    assert.throws(() => localImageId(() => listing, reference));
  }
});
