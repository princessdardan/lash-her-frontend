import { withWriterAdmission } from "@/lib/writer-admission/route";
import { handleShippingLabel } from "./handler";

export const GET = withWriterAdmission("recovery", handleShippingLabel);
