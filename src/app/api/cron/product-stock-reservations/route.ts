import { createAbandonedProductStockCronHandler } from "@/lib/commerce/product-stock-abandoned-sweep-cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createAbandonedProductStockCronHandler();
