import assert from "node:assert/strict";
import test from "node:test";
import {
  markdownToPortableText,
  portableTextToMarkdown,
} from "@portabletext/markdown";

test("Sanity's markdown parser handles links, formatting, and nested lists", () => {
  const blocks = markdownToPortableText(`
# Service care

Read the **aftercare** [guide](https://example.com/aftercare).

- Clean lashes daily
  - Use an oil-free cleanser
`);

  assert.equal(blocks[0]?.style, "h1");
  assert.equal(blocks[0]?.children[0]?.text, "Service care");

  const paragraph = blocks[1];
  assert.equal(paragraph?._type, "block");
  assert.equal(
    paragraph?.children.some(
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

  const listBlocks = blocks.filter((block) => block.listItem === "bullet");
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

  const reparsedListBlocks = markdownToPortableText(roundTrip).filter(
    (block) => block.listItem === "bullet",
  );
  assert.deepEqual(
    reparsedListBlocks.map((block) => block.level),
    [1, 2],
  );
});
