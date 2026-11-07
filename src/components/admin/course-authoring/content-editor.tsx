"use client";
import type { ContentDocument } from "@/lib/course-authoring/types";
import { fieldClass, secondaryClass } from "./course-fields";
type Block = ContentDocument["blocks"][number];

function nextKey(prefix: string, siblings: readonly { _key: string }[]): string {
  const occupied = new Set(siblings.map((item) => item._key));
  let index = 1;
  while (occupied.has(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
}

function newTextBlock(revision: number, blocks: readonly Block[]): Block {
  return {
    _type: "block",
    _key: nextKey(`block-${revision}`, blocks),
    style: "normal",
    children: [{ _type: "span", _key: `span-${revision}-1`, text: "", marks: [] }],
    markDefs: [],
  };
}
export function ContentEditor({
  value,
  revision,
  onChange,
}: {
  value: ContentDocument;
  revision: number;
  onChange: (value: ContentDocument) => void;
}) {
  function update(index: number, block: Block) {
    onChange({
      ...value,
      blocks: value.blocks.map((item, i) => (i === index ? block : item)),
    });
  }
  function move(index: number, offset: number) {
    const blocks = [...value.blocks];
    [blocks[index], blocks[index + offset]] = [
      blocks[index + offset],
      blocks[index],
    ];
    onChange({ ...value, blocks });
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-lh-muted">
        Add paragraphs, headings or lists. Formatting and links stay attached to
        each text section.
      </p>
      {value.blocks.map((block, index) => (
        <fieldset
          key={block._key}
          className="space-y-3 rounded-xl border border-lh-line p-4"
        >
          <legend className="px-1 text-sm font-semibold">
            Content block {index + 1}
          </legend>
          <div className="flex flex-wrap gap-3">
            <label className="text-sm">
              Style
              <select
                className={fieldClass}
                value={block.listItem ?? block.style ?? "normal"}
                onChange={(event) => {
                  const style = event.target.value;
                  if (style === "bullet" || style === "number")
                    update(index, {
                      ...block,
                      listItem: style,
                      level: block.level ?? 1,
                      style: "normal",
                    });
                  else {
                    const next = { ...block };
                    delete next.listItem;
                    delete next.level;
                    update(index, { ...next, style: style as Block["style"] });
                  }
                }}
              >
                <option value="normal">Paragraph</option>
                {[1, 2, 3, 4, 5, 6].map((level) => (
                  <option key={level} value={`h${level}`}>
                    Heading {level}
                  </option>
                ))}
                <option value="blockquote">Quotation</option>
                <option value="bullet">Bulleted list item</option>
                <option value="number">Numbered list item</option>
              </select>
            </label>
            {block.listItem && (
              <label className="text-sm">
                List level
                <input
                  type="number"
                  min={1}
                  max={6}
                  className={fieldClass}
                  value={block.level ?? 1}
                  onChange={(event) =>
                    update(index, {
                      ...block,
                      level: Number(event.target.value),
                    })
                  }
                />
              </label>
            )}
          </div>
          {block.children.map((span, spanIndex) => (
            <div key={span._key} className="space-y-2">
              <label className="block text-sm">
                Text {spanIndex + 1}
                <textarea
                  className={fieldClass}
                  rows={3}
                  value={span.text}
                  maxLength={500000}
                  onChange={(event) =>
                    update(index, {
                      ...block,
                      children: block.children.map((item, i) =>
                        i === spanIndex
                          ? { ...item, text: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </label>
              <div className="flex flex-wrap gap-4">
                {["strong", "em", "underline", "strike-through", "code"].map(
                  (mark) => (
                    <label
                      key={mark}
                      className="flex items-center gap-1 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={span.marks?.includes(mark) ?? false}
                        onChange={(event) =>
                          update(index, {
                            ...block,
                            children: block.children.map((item, i) =>
                              i === spanIndex
                                ? {
                                    ...item,
                                    marks: event.target.checked
                                      ? [...(item.marks ?? []), mark]
                                      : (item.marks?.filter(
                                          (value) => value !== mark,
                                        ) ?? []),
                                  }
                                : item,
                            ),
                          })
                        }
                      />
                      {
                        {
                          strong: "Bold",
                          em: "Italic",
                          underline: "Underline",
                          "strike-through": "Strikethrough",
                          code: "Code",
                        }[mark]
                      }
                    </label>
                  ),
                )}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={secondaryClass}
              onClick={() =>
                update(index, {
                  ...block,
                  children: [
                    ...block.children,
                    {
                      _type: "span",
                      _key: nextKey(`span-${revision}`, block.children),
                      text: "",
                      marks: [],
                    },
                  ],
                })
              }
            >
              Add text section
            </button>
            <button
              type="button"
              className={secondaryClass}
              disabled={index === 0}
              onClick={() => move(index, -1)}
              aria-label={`Move content block ${index + 1} up`}
            >
              Move up
            </button>
            <button
              type="button"
              className={secondaryClass}
              disabled={index === value.blocks.length - 1}
              onClick={() => move(index, 1)}
              aria-label={`Move content block ${index + 1} down`}
            >
              Move down
            </button>
            <button
              type="button"
              className={secondaryClass}
              onClick={() =>
                onChange({
                  ...value,
                  blocks: value.blocks.filter((_, i) => i !== index),
                })
              }
            >
              Remove block
            </button>
          </div>
          {(block.markDefs ?? []).map((link) => (
            <label key={link._key} className="block text-sm">
              Link address
              <input
                inputMode="url"
                className={fieldClass}
                value={link.href}
                onChange={(event) =>
                  update(index, {
                    ...block,
                    markDefs: block.markDefs?.map((item) =>
                      item._key === link._key
                        ? { ...item, href: event.target.value }
                        : item,
                    ),
                  })
                }
              />
            </label>
          ))}
          <button
            type="button"
            className={secondaryClass}
            onClick={() => {
              const id = nextKey(`link-${revision}`, block.markDefs ?? []);
              update(index, {
                ...block,
                markDefs: [
                  ...(block.markDefs ?? []),
                  { _type: "link", _key: id, href: "https://" },
                ],
                children: block.children.map((span, i) =>
                  i === 0
                    ? { ...span, marks: [...(span.marks ?? []), id] }
                    : span,
                ),
              });
            }}
          >
            Link first text section
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className={secondaryClass}
        onClick={() =>
          onChange({
            ...value,
            blocks: [...value.blocks, newTextBlock(revision, value.blocks)],
          })
        }
      >
        Add content block
      </button>
    </div>
  );
}
