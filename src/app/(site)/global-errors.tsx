"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, RefreshCw, AlertTriangle } from "lucide-react";
import { FallbackHeader } from "@/components/custom/layouts/fallback-header";
import { Button } from "@/components/ui/button";

const styles = {
  container:
    "min-h-screen bg-background flex items-center justify-center p-4",
  content: "max-w-2xl mx-auto text-center space-y-8",
  textSection: "space-y-4",
  headingError: "text-8xl font-heading text-lh-accent select-none",
  headingContainer: "relative",
  pageTitle: "text-4xl font-heading text-foreground mb-4",
  description: "text-lg text-lh-muted max-w-md mx-auto leading-relaxed font-body",
  illustrationContainer: "flex justify-center py-8",
  illustration: "relative animate-pulse",
  errorCircle:
    "w-32 h-32 bg-lh-neutral rounded-full flex items-center justify-center transition-all duration-300",
  errorIcon: "w-16 h-16 text-lh-accent",
  warningBadge:
    "absolute -top-2 -right-2 w-8 h-8 bg-lh-accent/10 rounded-full flex items-center justify-center animate-bounce",
  warningSymbol: "text-lh-accent text-xl font-bold",
  buttonContainer:
    "flex flex-col sm:flex-row gap-4 justify-center items-center",
  button: "min-w-[160px]",
  buttonContent: "flex items-center gap-2",
  buttonIcon: "w-4 h-4",
  outlineButton: "min-w-[160px]",
  errorDetails:
    "mt-8 p-4 bg-lh-neutral border border-lh-line rounded-lg text-left text-sm text-foreground",
  errorTitle: "font-bold mb-2",
};

interface IGlobalError {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: IGlobalError) {
  const pathname = usePathname();
  const isHomePage = pathname === "/";

  return (
    <html>
      <body>
        <FallbackHeader
          header={{
            logoText: {
              href: "/",
              label: "Lash Her by Nataliea",
            },
            ctaButton: [
              {
                label: "Book Now",
                href: "https://www.fresha.com/a/lash-her-by-nataliea-toronto-646-oakwood-avenue-tvrir5sx",
                isExternal: true,
              },
            ],
          }}
        />
        <div className={styles.container}>
          <div className={styles.content}>
            {/* Large Error Text */}
            <div className={styles.textSection}>
              <h1 className={styles.headingError}>Global Error</h1>
              <div className={styles.headingContainer}>
                <h2 className={styles.pageTitle}>Application Error</h2>
                <p className={styles.description}>
                  A critical error occurred that prevented the application from
                  loading properly. Please try refreshing the page.
                </p>
              </div>
            </div>

            {/* Illustration */}
            <div className={styles.illustrationContainer}>
              <div className={styles.illustration}>
                <div className={styles.errorCircle}>
                  <AlertTriangle className={styles.errorIcon} />
                </div>
                <div className={styles.warningBadge}>
                  <span className={styles.warningSymbol}>!</span>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className={styles.buttonContainer}>
              <Button
                variant="accent"
                size="lg"
                onClick={reset}
                className={styles.button}
              >
                <span className={styles.buttonContent}>
                  <RefreshCw className={styles.buttonIcon} />
                  Try Again
                </span>
              </Button>

              {!isHomePage && (
                <Button asChild variant="ghost" size="lg" className={styles.outlineButton}>
                  <Link href="/">
                    <span className={styles.buttonContent}>
                      <Home className={styles.buttonIcon} />
                      Go Home
                    </span>
                  </Link>
                </Button>
              )}
            </div>

            {process.env.NODE_ENV === "development" && (
              <div className={styles.errorDetails}>
                <div className={styles.errorTitle}>
                  Error Details (Development Only):
                </div>
                <div>Message: {error.message}</div>
                {error.digest && <div>Digest: {error.digest}</div>}
                {error.stack && (
                  <details className="mt-2">
                    <summary className="cursor-pointer font-bold">
                      Stack Trace
                    </summary>
                    <pre className="mt-2 text-xs overflow-auto">
                      {error.stack}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}
