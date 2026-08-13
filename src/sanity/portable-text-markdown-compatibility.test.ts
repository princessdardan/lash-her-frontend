import assert from "node:assert/strict";
import test from "node:test";
import {
  markdownToPortableText,
  portableTextToMarkdown,
} from "@portabletext/markdown";

interface TestSpan {
  _type?: string;
  marks?: string[];
  text?: string;
}

interface TestMarkDefinition {
  _type?: string;
  href?: string;
}

interface TestBlock {
  _type?: string;
  children?: TestSpan[];
  level?: number;
  listItem?: string;
  markDefs?: TestMarkDefinition[];
  style?: string;
}

test("Sanity's markdown parser handles links, formatting, and nested lists", () => {
  const blocks = markdownToPortableText(`
# Service care

Read the **aftercare** [guide](https://example.com/aftercare).

- Clean lashes daily
  - Use an oil-free cleanser
`);
  const testBlocks = blocks as unknown as TestBlock[];

  assert.equal(testBlocks[0]?.style, "h1");
  assert.equal(testBlocks[0]?.children?.[0]?.text, "Service care");

  const paragraph = testBlocks[1];
  assert.equal(paragraph?._type, "block");
  assert.equal(
    paragraph?.children?.some(
      (child) => child._type === "span" && child.marks?.includes("strong"),
    ),
    true,
  );
  assert.equal(
    paragraph?.markDefs?.some(
      (mark) =>
        mark._type === "link" &&
        "href" in mark &&
        mark.href === "https://example.com/aftercare",
    ),
    true,
  );

  const listBlocks = testBlocks.filter((block) => block.listItem === "bullet");
  assert.deepEqual(
    listBlocks.map((block) => block.level),
    [1, 2],
  );

  const roundTrip = portableTextToMarkdown(blocks);
  assert.match(roundTrip, /^# Service care/m);
  assert.match(roundTrip, /\*\*aftercare\*\*/);
  assert.match(roundTrip, /https:\/\/example\.com\/aftercare/);
  assert.match(roundTrip, /Clean lashes daily/);
  assert.match(roundTrip, /Use an oil-free cleanser/);

  const reparsedListBlocks = (
    markdownToPortableText(roundTrip) as unknown as TestBlock[]
  ).filter((block) => block.listItem === "bullet");
  assert.deepEqual(
    reparsedListBlocks.map((block) => block.level),
    [1, 2],
  );
});
