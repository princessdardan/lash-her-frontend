import { withWriterAdmission } from "@/lib/writer-admission/route";
import { POST as handler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withWriterAdmission("new-work", handler);
