import { PortableText, type PortableTextComponents } from "@portabletext/react";
import type { TPortableTextBlock } from "@/types";

// Defined at module scope for referential stability across renders (per React Compiler — no useMemo needed)
const components: PortableTextComponents = {
  block: {
    normal: ({ children }) => (
      <p className="mb-4 text-base font-bold leading-relaxed">{children}</p>
    ),
    h2: ({ children }) => (
      <h2 className="text-3xl md:text-4xl font-normal font-heading text-lh-shadow mb-4 mt-8 tracking-[-0.02em]">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-2xl md:text-3xl font-normal font-heading text-lh-shadow mb-3 mt-6 tracking-[-0.01em]">
        {children}
      </h3>
    ),
  },
  marks: {
    strong: ({ children }) => <strong className="font-bold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    link: ({ value, children }) => {
      const target = value?.blank === true ? "_blank" : undefined;
      return (
        <a
          href={value?.href}
          target={target}
          rel={target ? "noopener noreferrer" : undefined}
          className="text-lh-primary underline underline-offset-4 hover:text-lh-accent focus-visible:outline-lh-primary"
        >
          {children}
        </a>
      );
    },
  },
  list: {
    bullet: ({ children }) => (
      <ul className="list-disc list-outside pl-6 mb-4 space-y-1">{children}</ul>
    ),
    number: ({ children }) => (
      <ol className="list-decimal list-outside pl-6 mb-4 space-y-1">
        {children}
      </ol>
    ),
  },
  listItem: {
    bullet: ({ children }) => (
      <li className="marker:text-lh-primary">{children}</li>
    ),
    number: ({ children }) => (
      <li className="marker:text-lh-primary">{children}</li>
    ),
  },
};

interface PortableTextRendererProps {
  content: TPortableTextBlock[];
}

export function PortableTextRenderer({ content }: PortableTextRendererProps) {
  if (!content || !Array.isArray(content) || content.length === 0) {
    return null;
  }

  return <PortableText value={content} components={components} />;
}
