import { withWriterAdmission } from "@/lib/writer-admission/route";
import { POST as handler } from "./handler";

export const runtime = "nodejs";

export const POST = withWriterAdmission("recovery", handler);
