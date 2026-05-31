#!/usr/bin/env tsx

process.env.NEXT_PUBLIC_SANITY_DATASET ??= "test";
process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ??= "test-project";

const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: npm run resend:seed-templates -- [--apply]

Dry-run mode is the default. It prints the Resend template payload summary and matching RESEND_TEMPLATE_*_ID env var names without calling Resend.

Options:
  --apply   Create and publish each template with a Full access RESEND_API_KEY, then print .env lines.
  --help    Show this help text.`);
  process.exit(0);
}

const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--apply");

if (unknownArgs.length > 0) {
  throw new Error(`Unknown argument: ${unknownArgs.join(", ")}`);
}

async function main(): Promise<void> {
  const { seedResendTemplates } = await import("../src/lib/resend-template-seeding");

  await seedResendTemplates({ apply: args.has("--apply") });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

export {};
