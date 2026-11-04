import { withWriterAdmission } from "@/lib/writer-admission/route";
import { GET, POST as handler, unavailableMarketingUnsubscribeResponse } from "./handler";

export const runtime = "nodejs";

export { GET };
export const POST = withWriterAdmission("recovery", handler, undefined, unavailableMarketingUnsubscribeResponse);
