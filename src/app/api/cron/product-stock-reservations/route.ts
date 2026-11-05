import { createAbandonedProductStockCronHandler } from "@/lib/commerce/product-stock-abandoned-sweep-cron";
import { runWriterAdmission } from "@/lib/writer-admission/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createAbandonedProductStockCronHandler(undefined, (task) =>
  runWriterAdmission("recovery", task, {
    uncertainResult: (result) => result.failed > 0,
  }),
);
