import { createShippingIntakeLocationHandlers } from "./handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handlers = createShippingIntakeLocationHandlers();

export const POST = handlers.POST;
