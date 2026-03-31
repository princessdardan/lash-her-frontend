import React, { Suspense } from "react";
import type { TLayoutBlock } from "@/types";
import { BlockErrorBoundary } from "./block-error-boundary";
import { BlockAnimationWrapper } from "./block-animation-wrapper";
import { HeroSection } from "./hero-section";
import { FeaturesSection } from "./features-section";
import { CtaFeaturesSection } from "./cta-features-section";
import { ImageWithText } from "./image-with-text";
import { InfoSection } from "./info-section";
import { Gallery } from "./gallery";
import { Schedule } from "./schedule";
import { ContactInfo } from "./contact-info";
import { ContactFormLabels } from "../collection/contact-components";

export type { TLayoutBlock } from "@/types";

/**
 * Base interface that all blocks should extend
 */
interface BaseBlock {
  _type: string;
  _key?: string;
}

/**
 * Component Registry Pattern
 * Maps Sanity _type names to their corresponding React components
 */
const COMPONENT_REGISTRY = {
  "heroSection": HeroSection,
  "featuresSection": FeaturesSection,
  "ctaFeaturesSection": CtaFeaturesSection,
  "imageWithText": ImageWithText,
  "infoSection": InfoSection,
  "photoGallery": Gallery,
  "schedule": Schedule,
  "contactInfo": ContactInfo,
  "contactFormLabels": ContactFormLabels,
} as const;

/**
 * Components that should not be rendered directly
 */
const NON_RENDERABLE_COMPONENTS = new Set([
  "generalInquiryLabels",
]);

/**
 * Components that should skip entrance animations (e.g., hero sections
 * that handle their own animations or need to be visible immediately)
 */
const SKIP_ANIMATION = new Set([
  "heroSection",
]);

/**
 * Get a unique key for a block
 * Prefers Sanity's _key, falls back to index
 */
function getBlockKey(block: BaseBlock, index: number): string {
  if (block._key) return `${block._type}-${block._key}`;
  return `${block._type}-${index}`;
}

/**
 * PHASE 3: Default skeleton loader for Suspense
 */
function BlockSkeleton() {
  return (
    <div className="animate-pulse bg-gray-200 h-64 w-full rounded-md my-4" />
  );
}

/**
 * PHASE 3: Options for rendering blocks
 */
interface RenderBlockOptions {
  /** Whether to wrap blocks in error boundaries (default: true) */
  useErrorBoundary?: boolean;
  /** Whether to wrap blocks in Suspense (default: false) */
  useSuspense?: boolean;
  /** Custom fallback for Suspense */
  suspenseFallback?: React.ReactNode;
  /** PHASE 3: Callback when a block renders */
  onBlockRender?: (componentName: string, index: number) => void;
}

/**
 * Consolidated block renderer for all layout components
 * PHASE 1: Uses component registry pattern
 * PHASE 1: Includes error boundaries
 * PHASE 1: Uses stable keys
 * PHASE 3: Supports Suspense and analytics
 */
export function renderBlock(
  block: TLayoutBlock,
  index: number,
  options: RenderBlockOptions = {}
): React.ReactNode {
  const {
    useErrorBoundary = true,
    useSuspense = false,
    suspenseFallback = <BlockSkeleton />,
    onBlockRender,
  } = options;

  const componentName = block._type;

  // Check if component should not be rendered
  if (NON_RENDERABLE_COMPONENTS.has(componentName)) {
    return null;
  }

  // Get the component from registry
  const Component = COMPONENT_REGISTRY[componentName as keyof typeof COMPONENT_REGISTRY];

  // Handle unknown components
  if (!Component) {
    if (process.env.NODE_ENV === "development") {
      console.warn(`Unknown block component type: ${componentName}`);
    }
    return null;
  }

  // PHASE 3: Track block render
  if (onBlockRender) {
    onBlockRender(componentName, index);
  }

  // Use stable key based on Sanity _key
  const key = getBlockKey(block as BaseBlock, index);

  // Render the component — cast needed because registry union intersection collapses to never
  const RenderedComponent = Component as React.ComponentType<{ data: TLayoutBlock }>;
  let element = <RenderedComponent key={key} data={block} />;

  // Wrap in scroll-based entrance animation unless skipped
  if (!SKIP_ANIMATION.has(componentName)) {
    element = (
      <BlockAnimationWrapper key={`anim-${key}`}>
        {element}
      </BlockAnimationWrapper>
    );
  }

  // PHASE 3: Wrap in Suspense if requested
  if (useSuspense) {
    element = (
      <Suspense key={`suspense-${key}`} fallback={suspenseFallback}>
        {element}
      </Suspense>
    );
  }

  // PHASE 1: Wrap in error boundary if requested
  if (useErrorBoundary) {
    element = (
      <BlockErrorBoundary key={`error-${key}`} componentName={componentName}>
        {element}
      </BlockErrorBoundary>
    );
  }

  return element;
}

/**
 * Utility component to render an array of blocks
 */
export function BlockRenderer({
  blocks,
  options,
}: {
  blocks: TLayoutBlock[];
  options?: RenderBlockOptions;
}) {
  return <>{blocks.map((block, index) => renderBlock(block, index, options))}</>;
}

/**
 * PHASE 3: Hook to get block rendering stats (useful for debugging)
 */
export function useBlockStats(blocks: TLayoutBlock[]) {
  const stats = blocks.reduce((acc, block) => {
    const type = block._type;
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return {
    total: blocks.length,
    byType: stats,
    types: Object.keys(stats),
  };
}
