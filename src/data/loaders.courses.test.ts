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

test("migration export retains published course keys and both old and current media references", async () => {
  const exportQuery = source
    .slice(source.indexOf("async function getLegacyShortCourseMigrationExport"))
    .match(/groq`([^`]+)`/)![1]
    .replaceAll("${PUBLISHED_COURSE_FILTER}", filter);
  const course = {
    _type: "shortCourse", _id: "course", _rev: "revision-1",
    title: "Practice", slug: { current: "practice" }, introduction: "Introduction.",
    coverImage: { asset: { _ref: "image" }, alt: "Cover", crop: { left: 0.25 } },
    seo: { noIndex: true },
    modules: [{
      _key: "module", title: "Module", transcript: "Transcript.",
      lesson: [{ _type: "block", _key: "block", children: [{ _type: "span", _key: "span", text: "Lesson" }] }],
      muxVideo: { asset: { _ref: "mux" } },
      video: { asset: { _ref: "video" } },
      poster: { asset: { _ref: "image" } },
      captions: { asset: { _ref: "captions" } },
      quiz: [{ _key: "q", prompt: "Prompt", explanation: "Feedback", options: [{ _key: "a", text: "Correct", isCorrect: true }] }],
    }],
  };
  const result = await evaluate(parse(exportQuery), { dataset: [
    course, { ...course, _id: "drafts.course" }, { ...course, _id: "versions.release.course" },
    { _id: "mux", assetId: "asset", status: "ready", data: { playback_ids: [{ id: "signed", policy: "signed" }, { id: "public", policy: "public" }] } },
    { _id: "video", url: "https://cdn.sanity.io/video.mp4" },
    { _id: "image", url: "https://cdn.sanity.io/cover.png" },
    { _id: "captions", url: "https://cdn.sanity.io/captions.vtt" },
  ] });
  assert.deepEqual(await result.get(), { count: 1, courses: [{
    _id: "course", _rev: "revision-1", slug: "practice", title: "Practice", introduction: "Introduction.",
    cover: { id: "image", url: "https://cdn.sanity.io/cover.png", alt: "Cover", crop: { left: 0.25 }, hotspot: null },
    seo: { title: null, description: null, noIndex: true },
    modules: [{
      _key: "module", title: "Module", lesson: course.modules[0].lesson, transcript: "Transcript.",
      mux: { id: "mux", assetId: "asset", status: "ready", publicPlaybackId: "public", thumbTime: null },
      video: { id: "video", url: "https://cdn.sanity.io/video.mp4" },
      poster: { id: "image", url: "https://cdn.sanity.io/cover.png", crop: null, hotspot: null },
      captions: { id: "captions", url: "https://cdn.sanity.io/captions.vtt" },
      quiz: course.modules[0].quiz,
    }],
  }] });
});
