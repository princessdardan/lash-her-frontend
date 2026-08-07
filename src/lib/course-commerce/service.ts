import "server-only";

import { createDrizzleCourseLifecycleRepository } from "./drizzle-lifecycle-repository";
import { createCourseLifecycleService } from "./lifecycle";

let lifecycleService: ReturnType<typeof createCourseLifecycleService> | null =
  null;

function getCourseLifecycleService() {
  lifecycleService ??= createCourseLifecycleService(
    createDrizzleCourseLifecycleRepository(),
  );
  return lifecycleService;
}

export function finalizeCoursePayment(
  input: Parameters<
    ReturnType<typeof createCourseLifecycleService>["finalizeCoursePayment"]
  >[0],
) {
  return getCourseLifecycleService().finalizeCoursePayment(input);
}

export function claimGuestCourseOrder(
  input: Parameters<
    ReturnType<typeof createCourseLifecycleService>["claimGuestCourseOrder"]
  >[0],
) {
  return getCourseLifecycleService().claimGuestCourseOrder(input);
}
