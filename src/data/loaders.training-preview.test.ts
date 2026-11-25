import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluate, parse } from "groq-js";

const source = readFileSync(new URL("./loaders.ts", import.meta.url), "utf8");
const query = parse(
  source.slice(source.indexOf("async function getTrainingProgramBySlug")).match(/groq`([^`]+)`/)![1],
);

async function projectPreview(
  asset?: Record<string, unknown>,
  hasReference = true,
) {
  const result = await evaluate(query, {
    params: { slug: "group-class" },
    dataset: [
      {
        _type: "trainingProgram",
        _id: "training-program",
        slug: { current: "group-class" },
        ...(hasReference && { previewVideo: { asset: { _ref: "preview-asset" } } }),
      },
      ...(asset ? [{ _type: "mux.videoAsset", _id: "preview-asset", ...asset }] : []),
    ],
  });

  return (await result.get()).previewVideo;
}

test("training previews select public playback and the Studio thumbnail time", async () => {
  assert.deepEqual(
    await projectPreview({
      status: "ready",
      thumbTime: 12,
      data: {
        playback_ids: [
          { id: "signed-id", policy: "signed" },
          { id: "public-id", policy: "public" },
        ],
      },
    }),
    { isReady: true, playbackId: "public-id", thumbTime: 12 },
  );
});

test("training previews distinguish missing, processing, and signed-only assets", async () => {
  assert.equal(await projectPreview(undefined, false), null);
  assert.equal(await projectPreview(), null);

  for (const status of ["preparing", "errored"]) {
    const preview = await projectPreview({
      status,
      data: { playback_ids: [{ id: "public-id", policy: "public" }] },
    });
    assert.equal(preview.isReady, false);
  }

  const signedOnly = await projectPreview({
    status: "ready",
    playbackId: "signed-id",
    data: { playback_ids: [{ id: "signed-id", policy: "signed" }] },
  });
  assert.equal(signedOnly.playbackId, null);
});
