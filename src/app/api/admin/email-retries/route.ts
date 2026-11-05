import { withWriterAdmission } from "@/lib/writer-admission/route";
import { POST as handler } from "./handler";

export const POST = withWriterAdmission("recovery", handler);

export const runtime = "nodejs";
