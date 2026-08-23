import { type NextRequest } from "next/server";

import { handlePackageProfileCreate } from "./handler";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  return handlePackageProfileCreate(request);
}
