import { type NextRequest } from "next/server";

import { handlePackageProfileMutation } from "../handler";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return handlePackageProfileMutation(request, { entityId: id });
}
