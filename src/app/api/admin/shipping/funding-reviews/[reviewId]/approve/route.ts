import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { approveFundingReview } from "@/lib/shipping/funding";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<Response> {
  const actor = await requirePermission("settings:manage");
  if (req.headers.get("origin") !== req.nextUrl.origin)
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403 },
    );
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const { reviewId } = await params;
  try {
    const updated = await approveFundingReview({
      reviewId,
      actorAdminUserId: actor.user.id,
      markApplied: body?.markApplied === true,
    });
    return NextResponse.json({ id: updated.id, status: updated.status });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Funding approval failed",
      },
      { status: 409 },
    );
  }
}
