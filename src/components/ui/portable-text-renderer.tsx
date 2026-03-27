import { PortableText, type PortableTextComponents } from "@portabletext/react";
import type { TPortableTextBlock } from "@/types";

// Defined at module scope for referential stability across renders (per React Compiler — no useMemo needed)
const components: PortableTextComponents = {
  block: {
    normal: ({ children }) => (
      <p className="mb-4 text-base font-normal leading-relaxed">{children}</p>
    ),
    h2: ({ children }) => (
      <h2 className="text-2xl font-bold font-serif text-brand-red mb-3 mt-6">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-lg font-bold font-serif text-brand-red mb-2 mt-4">
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
          className="text-brand-red underline underline-offset-4 hover:text-brand-dark-red focus-visible:outline-brand-red"
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
      <li className="marker:text-brand-red">{children}</li>
    ),
    number: ({ children }) => (
      <li className="marker:text-brand-red">{children}</li>
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
