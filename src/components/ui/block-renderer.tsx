import React from "react";
import type { TPortableTextBlock } from "@/types";

interface BlockRendererProps {
  content: TPortableTextBlock[];
}

/**
 * Portable Text stub renderer.
 * Extracts plain text from Portable Text blocks.
 * Full styled renderer with @portabletext/react built in Phase 3 (RT-01).
 */
export function BlockRenderer({ content }: BlockRendererProps) {
  if (!content || !Array.isArray(content)) {
    return null;
  }

  return (
    <div className="prose max-w-none">
      {/* Portable Text renderer — Phase 3 */}
      {content.map((block) => (
        <p key={block._key} className="mb-4 mx-auto indent-3.5 text-base font-normal px-2 max-w-3xl">
          {block.children?.map((child) => child.text).join("")}
        </p>
      ))}
    </div>
  );
}
