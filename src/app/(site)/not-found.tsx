"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Home, Search, ArrowLeft } from "lucide-react";

const styles = {
  container:
    "min-h-[calc(100vh-200px)] mx-auto container my-8 flex items-center justify-center p-4 bg-background",
  content: "max-w-2xl mx-auto text-center space-y-8",
  textSection: "space-y-4",
  heading404: "text-9xl font-heading text-lh-primary select-none",
  headingContainer: "relative",
  pageTitle: "text-4xl font-heading text-foreground mb-4",
  description: "text-lg text-lh-muted max-w-md mx-auto leading-relaxed font-body",
  illustrationContainer: "flex justify-center py-8",
  illustration: "relative animate-pulse",
  searchCircle:
    "w-32 h-32 bg-lh-neutral rounded-full flex items-center justify-center transition-all duration-300",
  searchIcon: "w-16 h-16 text-lh-muted",
  errorBadge:
    "absolute -top-2 -right-2 w-8 h-8 bg-lh-accent/10 rounded-full flex items-center justify-center animate-bounce",
  errorSymbol: "text-lh-accent text-xl font-bold",
  buttonContainer:
    "flex flex-col sm:flex-row gap-4 justify-center items-center",
  button: "min-w-[160px]",
  buttonContent: "flex items-center gap-2",
  buttonIcon: "w-4 h-4",
  outlineButton: "min-w-[160px]",
};

export default function NotFound() {
  return (
    <section className={styles.container}>
      <section className={styles.content}>
        {/* Large 404 Text */}
        <header className={styles.textSection}>
          <h1 className={styles.heading404}>404</h1>
          <div className={styles.headingContainer}>
            <h2 className={styles.pageTitle}>Page Not Found</h2>
            <p className={styles.description}>
              Oops! The page you&apos;re looking for seems to have wandered off
              into the digital wilderness.
            </p>
          </div>
        </header>

        {/* Illustration */}
        <div className={styles.illustrationContainer}>
          <div className={styles.illustration}>
            <div className={styles.searchCircle}>
              <Search className={styles.searchIcon} />
            </div>
            <div className={styles.errorBadge}>
              <span className={styles.errorSymbol}>✕</span>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <nav className={styles.buttonContainer} aria-label="Page not found actions">
          <Button asChild variant="primary" size="lg" className={styles.button}>
            <Link href="/" className={styles.buttonContent}>
              <Home className={styles.buttonIcon} />
              Go Home
            </Link>
          </Button>

          <Button
            variant="ghost"
            size="lg"
            className={styles.outlineButton}
            onClick={() => window.history.back()}
          >
            <span className={styles.buttonContent}>
              <ArrowLeft className={styles.buttonIcon} />
              Go Back
            </span>
          </Button>
        </nav>
      </section>
    </section>
  );
}
