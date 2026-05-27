import { draftMode } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

function getRedirectPath(request: NextRequest): string {
  const redirectPath = request.nextUrl.searchParams.get("redirect");

  if (!redirectPath?.startsWith("/") || redirectPath.startsWith("//")) {
    return "/";
  }

  return redirectPath;
}

export async function GET(request: NextRequest) {
  const mode = await draftMode();
  mode.disable();

  return NextResponse.redirect(new URL(getRedirectPath(request), request.url));
}
