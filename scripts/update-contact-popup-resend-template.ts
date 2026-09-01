#!/usr/bin/env tsx

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

process.env.NEXT_PUBLIC_SANITY_DATASET ??= "test";
process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ??= "test-project";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: npm run resend:update-contact-popup-template -- --apply

Updates and publishes the configured contact popup customer template in Resend.

Options:
  --apply   Required. Update and publish the active configured template.
  --help    Show this help text.`);
  process.exit(0);
}

const unknownArgs = args.filter((arg) => arg !== "--apply");

if (unknownArgs.length > 0) {
  console.error("Unknown argument. Use --help for usage.");
  process.exit(1);
}

if (!args.includes("--apply")) {
  console.log("No changes made. Re-run with --apply to update the template.");
  process.exit(0);
}

async function main(): Promise<void> {
  const { updateAndPublishContactPopupCustomerTemplate } =
    await import("../src/lib/resend-template-seeding");

  await updateAndPublishContactPopupCustomerTemplate();
  console.log("Contact popup customer template updated and published.");
}

const SAFE_FAILURE_MESSAGES = new Set([
  "RESEND_TEMPLATE_CONTACT_POPUP_CUSTOMER_ID is required",
  "Contact popup customer template definition is missing",
  "Configured Resend template is not the Lash Her contact popup customer template",
  "Configured Resend contact popup customer template is not safe to update",
  "Published Resend contact popup customer template failed verification",
]);

main().catch((error: unknown) => {
  const safeMessage =
    error instanceof Error && SAFE_FAILURE_MESSAGES.has(error.message)
      ? error.message
      : "Contact popup customer template update failed.";
  console.error(safeMessage);
  process.exit(1);
});

export {};
