import assert from "node:assert/strict";
import test from "node:test";
import { detectContentType } from "next/dist/server/image-optimizer/detect-content-type";
import { getImageSize } from "next/dist/server/image-optimizer/get-image-size";
import { optimizeImage } from "next/dist/server/image-optimizer/transform";

const twoPixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWM4MqXiPwgzwBgAZAQLPcHL1fcAAAAASUVORK5CYII=",
  "base64",
);

test("Next's image optimizer loads Sharp and performs a WebP resize", async () => {
  const optimized = await optimizeImage({
    buffer: twoPixelPng,
    contentType: "image/webp",
    quality: 75,
    width: 1,
  });

  assert.equal(await detectContentType(optimized), "image/webp");
  assert.deepEqual(await getImageSize(optimized), { height: 1, width: 1 });
});
