import { getAdminAuth } from "@/lib/admin/auth";
import { getPrivacyExportService, type BuildPrivacyExportInput } from "@/lib/admin/privacy-export";
import type { AdminActor } from "@/lib/admin/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

interface PrivacyExportRouteDependencies {
  buildExport: (input: BuildPrivacyExportInput) => Promise<unknown>;
  requireOwner: () => Promise<AdminActor>;
}

const defaultDependencies: PrivacyExportRouteDependencies = {
  buildExport: (input) => getPrivacyExportService().buildExport(input),
  requireOwner: () => getAdminAuth().requireOwner(),
};

export const POST = createPrivacyExportPostHandler(defaultDependencies);

export function createPrivacyExportPostHandler(dependencies: PrivacyExportRouteDependencies) {
  return async function privacyExportPostHandler(req: Request, context: RouteContext): Promise<Response> {
    let actor: AdminActor;

    try {
      actor = await dependencies.requireOwner();
    } catch {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await context.params;
    const formData = await req.formData();
    const reason = String(formData.get("reason") ?? "").trim();

    if (reason.length < 5) {
      return Response.json({ error: "Export reason is required" }, { status: 400 });
    }

    try {
      const exportPackage = await dependencies.buildExport({
        actor,
        privacyRequestId: id,
        reason,
      });

      return Response.json(exportPackage, {
        headers: {
          "content-disposition": `attachment; filename="privacy-export-${id}.json"`,
        },
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Privacy export failed" },
        { status: 400 },
      );
    }
  };
}
