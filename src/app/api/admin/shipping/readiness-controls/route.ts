import { createShippingReadinessControlHandlers } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createShippingReadinessControlHandlers();

export const GET = handlers.GET;
export const POST = handlers.POST;
