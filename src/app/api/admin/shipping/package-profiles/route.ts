import { withWriterAdmission } from "@/lib/writer-admission/route";
import { type NextRequest } from "next/server";

import { handlePackageProfileCreate } from "./handler";

export const runtime = "nodejs";

async function handlePost(request: NextRequest): Promise<Response> {
  return handlePackageProfileCreate(request);
}

export const POST = withWriterAdmission("new-work", handlePost);
