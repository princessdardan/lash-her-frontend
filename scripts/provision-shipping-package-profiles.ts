/**
 * Historical package provisioning is read-only. Real package approval uses
 * /admin/shipping-packages and its authenticated owner/step-up evidence.
 * The previous script manufactured review timestamps; that write path is retired.
 */
const boxes = [
  { slug: "mailer-box-30x22x5", lengthCm: 30, widthCm: 22, heightCm: 5, tareWeightGrams: 90, maxWeightGrams: 2_000 },
  { slug: "mailer-box-36x26x4", lengthCm: 36, widthCm: 26, heightCm: 4, tareWeightGrams: 120, maxWeightGrams: 3_000 },
];

if (process.env.PROVISION_PACKAGE_PROFILES === "1" || process.argv.includes("--execute")) {
  console.error("[provision] Direct package approval is retired. Use /admin/shipping-packages for authenticated owner review.");
  process.exitCode = 1;
} else {
  console.info("[provision] Read-only historical box plan; no database or provider connection is opened.");
  for (const box of boxes) console.info(JSON.stringify(box));
}
