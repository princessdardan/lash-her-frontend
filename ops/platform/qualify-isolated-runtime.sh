#!/usr/bin/env bash
set -euo pipefail

# Keep each candidate's imported reference cache separate from the publisher
# and from every other candidate's cached results.
[[ $# -ge 5 ]]
prewarm_args=("$1" "$2" "$3" "$4")
shift 4

if [[ -n ${P506_PUBLISHER_BUILDER:-} ]]; then
  [[ $P506_PUBLISHER_BUILDER =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]
  docker buildx rm "$P506_PUBLISHER_BUILDER"
fi

reference_builder=$(docker buildx create --driver docker-container --driver-opt default-load=true)
[[ $reference_builder =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]
trap 'docker buildx rm "$reference_builder" >/dev/null 2>&1 || true' EXIT
export BUILDX_BUILDER="$reference_builder"

node "${BASH_SOURCE[0]%/*}/prewarm-candidate-runtime.mjs" "${prewarm_args[@]}"
"$@"
