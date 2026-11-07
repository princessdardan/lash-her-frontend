import { getAdminAccountExport } from "@/lib/customer-lifecycle/admin-handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ userId: string; commandId: string }> }) {
  const { userId, commandId } = await context.params;
  return getAdminAccountExport(request, userId, commandId);
}
