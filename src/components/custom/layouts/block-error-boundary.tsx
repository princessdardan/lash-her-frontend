"use client";

import React from "react";

/**
 * Error Boundary Fallback Component
 */
function BlockErrorFallback({
  componentName,
  error,
}: {
  componentName: string;
  error?: Error;
}) {
  if (process.env.NODE_ENV === "development") {
    return (
      <div className="border-2 border-red-500 bg-red-50 p-4 rounded-md my-4">
        <h3 className="text-red-700 font-semibold">
          Error rendering block: {componentName}
        </h3>
        {error && (
          <pre className="text-xs text-red-600 mt-2 overflow-auto">
            {error.message}
          </pre>
        )}
      </div>
    );
  }
  // In production, fail silently
  return null;
}

/**
 * Simple Error Boundary Component
 * Must be a Client Component to use componentDidCatch
 */
export class BlockErrorBoundary extends React.Component<
  { children: React.ReactNode; componentName: string },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { children: React.ReactNode; componentName: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(`Error in block component ${this.props.componentName}:`, error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <BlockErrorFallback
          componentName={this.props.componentName}
          error={this.state.error}
        />
      );
    }

    return this.props.children;
  }
}
