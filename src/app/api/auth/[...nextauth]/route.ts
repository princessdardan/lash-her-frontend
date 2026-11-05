import { handlers } from "@/auth";
import { withAdminAuthRouteAdmission } from "@/lib/admin/auth-route-admission";

export const GET = withAdminAuthRouteAdmission(handlers.GET);
export const POST = withAdminAuthRouteAdmission(handlers.POST);
