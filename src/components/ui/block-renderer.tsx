import React from "react";
import Image from "next/image";
import { Check } from "lucide-react";
import { BlocksContent, InlineNode } from "@/types";

interface BlockRendererProps {
  content: BlocksContent;
}

const renderInlineNodes = (nodes: InlineNode[]): React.ReactNode => {
  return nodes.map((node, index) => {
    if (node.type === "text") {
      let text: React.ReactNode = node.text;

      if (node.bold) {
        text = <strong key={index}>{text}</strong>;
      }
      if (node.italic) {
        text = <em key={index}>{text}</em>;
      }
      if (node.underline) {
        text = <u key={index}>{text}</u>;
      }
      if (node.strikethrough) {
        text = <s key={index}>{text}</s>;
      }
      if (node.code) {
        text = (
          <code
            key={index}
            className="rounded bg-gray-100 px-1 py-0.5 font-mono text-sm"
          >
            {text}
          </code>
        );
      }

      return <React.Fragment key={index}>{text}</React.Fragment>;
    }

    if (node.type === "link") {
      return (
        <a
          key={index}
          href={node.url}
          className="text-blue-600 hover:underline"
          target={node.url.startsWith("http") ? "_blank" : undefined}
          rel={node.url.startsWith("http") ? "noopener noreferrer" : undefined}
        >
          {renderInlineNodes(node.children)}
        </a>
      );
    }

    return null;
  });
};

export function BlockRenderer({ content }: BlockRendererProps) {
  if (!content || !Array.isArray(content)) {
    return null;
  }

  return (
    <div className="prose max-w-none">
      {content.map((block, index) => {
        switch (block.type) {
          case "paragraph":
            return <p className="mb-4 mx-auto text-center text-md font-normal px-2 max-w-3xl" key={index}>{renderInlineNodes(block.children)}</p>;

          case "heading": {
            const HeadingTag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
            
            const headingStyles = {
              1: "text-4xl font-bold text-gray-900 mb-4",
              2: "text-3xl font-semibold text-gray-800 mb-3",
              3: "text-2xl text-center font-semibold text-brand-red font-serif mb-3",
              4: "text-xl font-medium text-gray-700 mb-2",
              5: "text-lg font-medium text-gray-700 mb-1",
              6: "text-base font-medium text-gray-600 mb-1",
            };
            
            return (
              <HeadingTag key={index} className={headingStyles[block.level]}>
                {renderInlineNodes(block.children)}
              </HeadingTag>
            );
          }

          case "list":
            const ListTag = block.format === "ordered" ? "ol" : "ul";
            return (
              <ListTag key={index} className={block.format === "ordered" ? "list-decimal" : "list-none space-y-2"}>
                {block.children.map((item, itemIndex) => (
                  <li key={itemIndex} className={block.format === "unordered" ? "flex items-start py-0.5 gap-2" : ""}>
                    {block.format === "unordered" && (
                      <Check className="w-4 h-4 text-brand-red shrink-0 mt-0.5" />
                    )}
                    <span>{renderInlineNodes(item.children)}</span>
                  </li>
                ))}
              </ListTag>
            );

          case "quote":
            return (
              <blockquote
                key={index}
                className="border-l-4 border-gray-300 pl-4 italic"
              >
                {renderInlineNodes(block.children)}
              </blockquote>
            );

          case "code":
            return (
              <pre key={index} className="rounded bg-gray-100 p-4">
                <code>{renderInlineNodes(block.children)}</code>
              </pre>
            );

          case "image":
            return (
              <figure key={index} className="my-4">
                <Image
                  src={block.image.url}
                  alt={block.image.alternativeText || ""}
                  width={block.image.width}
                  height={block.image.height}
                  className="rounded"
                />
                {block.image.caption && (
                  <figcaption className="mt-2 text-center text-sm text-gray-600">
                    {block.image.caption}
                  </figcaption>
                )}
              </figure>
            );

          default:
            return null;
        }
      })}
    </div>
  );
}
