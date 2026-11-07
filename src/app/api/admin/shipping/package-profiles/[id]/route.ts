import { withWriterAdmission } from "@/lib/writer-admission/route";
import { type NextRequest } from "next/server";

import { handlePackageProfileMutation } from "../handler";

export const runtime = "nodejs";

async function handlePost(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return handlePackageProfileMutation(request, { entityId: id });
}

export const POST = withWriterAdmission("new-work", handlePost);
