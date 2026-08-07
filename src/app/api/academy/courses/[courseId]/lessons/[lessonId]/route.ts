import { auth } from "@/auth";
import { getAcademyConfig } from "@/lib/academy/config";
import { getAcademyCourseApi } from "@/lib/academy/course-api-adapter";
import { isActiveCustomerUser } from "@/lib/customer-identity/status";
import { createAcademyLessonGetHandler } from "./handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = createAcademyLessonGetHandler({
  authenticate: auth,
  courseApi: getAcademyCourseApi(),
  enabled: getAcademyConfig().enabled,
  isCustomerActive: isActiveCustomerUser,
  logError: console.error,
});
