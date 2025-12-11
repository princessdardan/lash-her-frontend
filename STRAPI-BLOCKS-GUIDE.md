# Strapi Block Rich Text - Frontend Type Guide

This guide explains how to properly type and render Strapi's block rich text editor content on the frontend.

## Type Definition

The `BlocksContent` type has been added to `/frontend/src/types/index.ts` and represents the structure of Strapi's block editor content.

### Supported Block Types

- **Paragraph** - Regular text paragraphs
- **Heading** - H1-H6 headings
- **List** - Ordered and unordered lists
- **Quote** - Blockquotes
- **Code** - Code blocks
- **Image** - Images with metadata
- **Link** - Hyperlinks

### Inline Formatting

Text nodes support:
- `bold` - **Bold text**
- `italic` - *Italic text*
- `underline` - Underlined text
- `strikethrough` - ~~Strikethrough text~~
- `code` - `Inline code`

## Usage Example

### 1. Type Your Component Props

```typescript
import { BlocksContent } from "@/types";

interface YourComponentProps {
  title: string;
  content: BlocksContent; // ← Type the blocks field like this
}
```

### 2. Use the BlockRenderer Component

```typescript
import { BlockRenderer } from "@/components/custom/block-renderer";
import { BlocksContent } from "@/types";

interface CtaFeatureProps {
  heading: string;
  features: BlocksContent;
}

export function CtaFeature({ heading, features }: CtaFeatureProps) {
  return (
    <div>
      <h2>{heading}</h2>
      <BlockRenderer content={features} />
    </div>
  );
}
```

### 3. Fetch Data from Strapi

When fetching from Strapi, the blocks field will automatically have the correct structure:

```typescript
// In your data loader
const response = await fetch(`${STRAPI_URL}/api/your-collection?populate=*`);
const data = await response.json();

// data.attributes.features will be of type BlocksContent
<YourComponent features={data.attributes.features} />
```

## Custom Styling

The `BlockRenderer` component includes basic Tailwind CSS classes. You can:

1. **Modify the component** at `/frontend/src/components/custom/block-renderer.tsx` to customize styles
2. **Use Tailwind's prose classes** for automatic typography styling
3. **Wrap in a custom container** with your own styles:

```typescript
<div className="my-custom-prose">
  <BlockRenderer content={features} />
</div>
```

## Block Structure Example

Here's what the actual data structure looks like:

```json
[
  {
    "type": "paragraph",
    "children": [
      {
        "type": "text",
        "text": "This is ",
        "bold": false
      },
      {
        "type": "text",
        "text": "bold text",
        "bold": true
      }
    ]
  },
  {
    "type": "heading",
    "level": 2,
    "children": [
      {
        "type": "text",
        "text": "A Heading"
      }
    ]
  }
]
```

## Reference

- **Type definitions**: `/frontend/src/types/index.ts`
- **Renderer component**: `/frontend/src/components/custom/block-renderer.tsx`
- **Example usage**: `/frontend/src/components/custom/example-cta-feature.tsx`
