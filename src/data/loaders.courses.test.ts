import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluate, parse } from "groq-js";

// Execute the actual loader query against asset documents, including mixed
// policies and missing weak references; projected fixtures cannot prove this.
const source = readFileSync(new URL("./loaders.ts", import.meta.url), "utf8");
const filter = source.match(
  /const PUBLISHED_COURSE_FILTER = groq`([^`]+)`/,
)![1];
const query = source
  .slice(source.indexOf("async function getShortCourseContent"))
  .match(/groq`([^`]+)`/)![1]
  .replace("${PUBLISHED_COURSE_FILTER}", filter);

async function projectVideo(
  asset: Record<string, unknown> | null,
  useMux = true,
) {
  const result = await evaluate(parse(query), {
    params: { courseId: "course" },
    dataset: [
      {
        _type: "shortCourse",
        _id: "course",
        modules: [
          {
            _key: "lesson",
            title: "Lesson",
            ...(useMux ? { muxVideo: { asset: { _ref: "mux-asset" } } } : {}),
            video: { asset: { _ref: "old-file" } },
          },
        ],
      },
      {
        _id: "old-file",
        _type: "sanity.fileAsset",
        url: "https://cdn.sanity.io/old.mp4",
      },
      ...(asset
        ? [{ _id: "mux-asset", _type: "mux.videoAsset", ...asset }]
        : []),
    ],
  });
  return (await result.get()).modules[0].video;
}

test("course query prefers a public Mux playback ID even when signed comes first", async () => {
  assert.deepEqual(
    await projectVideo({
      status: "ready",
      thumbTime: 12,
      playbackId: "signed-id",
      data: {
        playback_ids: [
          { id: "signed-id", policy: "signed" },
          { id: "public-id", policy: "public" },
        ],
      },
    }),
    {
      provider: "mux",
      id: "mux-asset",
      playbackId: "public-id",
      status: "ready",
      thumbTime: 12,
    },
  );
});

test("signed, processing, or missing Mux assets never fall back to legacy video", async () => {
  for (const asset of [
    null,
    { status: "preparing" },
    {
      status: "ready",
      playbackId: "signed-id",
      data: { playback_ids: [{ id: "signed-id", policy: "signed" }] },
    },
  ]) {
    const video = await projectVideo(asset);
    assert.equal(video.provider, "mux");
    assert.equal(video.playbackId, null);
    assert.equal(video.url, undefined);
  }
});

test("unmigrated courses retain their Sanity file and saved video identity", async () => {
  assert.deepEqual(await projectVideo(null, false), {
    provider: "sanity",
    id: "old-file",
    url: "https://cdn.sanity.io/old.mp4",
  });
});
