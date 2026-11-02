// Docker 29's containerd store distinguishes a runnable local index ID from
// a platform manifest ID. image inspect --platform returns the latter. Pin the
// runnable ID from the exact named reference, preserving digest verification.
export function localImageId(command, reference) {
  const [repository, expectedDigest] = reference.split("@");
  if (!repository || reference.split("@").length > 2 ||
      (expectedDigest && !/^sha256:[0-9a-f]{64}$/u.test(expectedDigest))) throw new Error("Local image reference required");
  const listing = command("docker", ["image", "ls", "--digests", "--no-trunc", "--filter", `reference=${repository}`, "--format", "{{json .}}"]);
  const records = listing.trim() ? listing.trim().split("\n").map((line) => JSON.parse(line)) : [];
  const ids = new Set(records.filter((item) => expectedDigest
    ? item.Repository === repository && item.Digest === expectedDigest
    : `${item.Repository}:${item.Tag}` === repository).map((item) => item.ID));
  if (ids.size !== 1 || !/^sha256:[0-9a-f]{64}$/u.test([...ids][0] ?? "") || /^sha256:0+$/u.test([...ids][0])) {
    throw new Error("Exact cached image identity required");
  }
  return [...ids][0];
}
