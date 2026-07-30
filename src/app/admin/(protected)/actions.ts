"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  createEmployeeCalendarConnection,
  disableEmployeeBusyAssignment,
  disconnectEmployeeCalendarConnection,
  saveEmployeeBusyAssignment,
} from "@/lib/admin/employee-calendar";
import {
  assignOfferingResource,
  assignStaffResource,
  cancelScheduleException,
  createBookingResource,
  createBookingService,
  createCalendarConnection,
  createOfferingAddOn,
  createResourceSchedule,
  createScheduleException,
  createServiceOffering,
  createStaffUser,
  disableCalendarAssignment,
  disableCalendarConnection,
  disableResourceSchedule,
  removeOfferingResource,
  saveCalendarAssignment,
  setAppointmentAttendanceStatus,
  setBookingResourceStatus,
  setBookingServiceStatus,
  setOfferingAddOnStatus,
  setServiceOfferingStatus,
  setStaffStatus,
  transferCalendarConnectionOwnership,
  unassignStaffResource,
  updateBookingResourceProfile,
  updateBookingServiceProfile,
  updateBookingSettings,
  updateServiceOffering,
} from "@/lib/admin/operations-write";
import { parseOperationalBookingQuestionsJson } from "@/lib/booking/operational-ui-settings";
import { AdminAuthError } from "@/lib/admin/types";
import {
  refreshSquareTeamMappings,
  setProviderSquareTeamMember,
  setSquareAttributionRequirement,
} from "@/lib/admin/square-team-attribution";
import { toContractorTerminology } from "@/lib/admin/presentation";

export async function setAppointmentAttendanceStatusAction(formData: FormData) {
  const rawAppointmentId = formData.get("appointmentId");
  const destination =
    typeof rawAppointmentId === "string" && rawAppointmentId
      ? `/admin/appointments/${encodeURIComponent(rawAppointmentId)}`
      : "/admin/appointments";
  return runAdminAction({
    destination,
    revalidatePaths: ["/admin", "/admin/appointments", destination],
    success: "Attendance status updated.",
    task: async () => {
      const status = getString(formData, "status");
      if (status !== "completed" && status !== "no_show") {
        throw new Error("Invalid attendance status");
      }
      await setAppointmentAttendanceStatus({
        appointmentId: getString(formData, "appointmentId"),
        status,
      });
    },
  });
}

export async function createStaffUserAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/staff?tab=people",
    revalidatePaths: ["/admin/staff"],
    success: "Staff member added.",
    task: async () => {
      const role = getString(formData, "role");
      if (role !== "admin" && role !== "employee") {
        throw new Error("Invalid staff role");
      }
      await createStaffUser({
        displayName: getOptionalString(formData, "displayName"),
        email: getString(formData, "email"),
        role,
      });
    },
  });
}

export async function setStaffStatusAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/staff?tab=people",
    revalidatePaths: ["/admin/staff"],
    success: "Staff status updated.",
    task: async () => {
      const status = getString(formData, "status");
      if (status !== "active" && status !== "disabled") {
        throw new Error("Invalid staff status");
      }
      await setStaffStatus({ status, userId: getString(formData, "userId") });
    },
  });
}

export async function assignStaffResourceAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/staff?tab=people",
    revalidatePaths: ["/admin/staff"],
    success: "Resource assigned.",
    task: () =>
      assignStaffResource({
        resourceId: getString(formData, "resourceId"),
        userId: getString(formData, "userId"),
      }),
  });
}

export async function unassignStaffResourceAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/staff?tab=people",
    revalidatePaths: ["/admin/staff"],
    success: "Resource access removed.",
    task: () =>
      unassignStaffResource({
        resourceId: getString(formData, "resourceId"),
        userId: getString(formData, "userId"),
      }),
  });
}

export async function refreshSquareTeamMappingsAction() {
  const outcome = await attemptAdminAction(refreshSquareTeamMappings);
  if (!outcome.ok) {
    redirect(feedbackUrl("/admin/staff", "error", outcome.error));
  }
  revalidatePath("/admin/staff");
  revalidatePath("/admin/setup");
  const query = new URLSearchParams({
    notice: "Square team mappings refreshed.",
    squareTeam: "1",
  });
  redirect(`/admin/staff?${query.toString()}`);
}

export async function setProviderSquareTeamMemberAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/staff?tab=square",
    revalidatePaths: ["/admin/staff", "/admin/setup", "/admin/offerings"],
    success: "Square team-member mapping saved.",
    task: () =>
      setProviderSquareTeamMember({
        providerId: getString(formData, "providerId"),
        squareTeamMemberSelectionHandle:
          getOptionalString(formData, "squareTeamMemberSelectionHandle") ??
          null,
      }),
  });
}

export async function setSquareAttributionRequirementAction(
  formData: FormData,
) {
  return runAdminAction({
    destination: "/admin/integrations",
    revalidatePaths: [
      "/admin",
      "/admin/integrations",
      "/admin/setup",
      "/admin/staff",
      "/admin/offerings",
    ],
    success: "Square attribution requirement updated.",
    task: () =>
      setSquareAttributionRequirement(
        getString(formData, "required") === "true",
      ),
  });
}

export async function createBookingResourceAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/staff?tab=resources",
    revalidatePaths: ["/admin/staff", "/admin/setup"],
    success: "Booking resource created as a draft.",
    task: async () => {
      const kind = getString(formData, "kind");
      if (kind !== "provider" && kind !== "room" && kind !== "equipment") {
        throw new Error("Invalid resource kind");
      }
      await createBookingResource({
        kind,
        name: getString(formData, "name"),
        publicSlug: getOptionalString(formData, "publicSlug"),
        resourceKey: getString(formData, "resourceKey"),
        sanityDocumentId: getOptionalString(formData, "sanityDocumentId"),
        timezone: getString(formData, "timezone"),
      });
    },
  });
}

export async function setBookingResourceStatusAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/staff?tab=resources",
    revalidatePaths: ["/admin/staff", "/admin/setup"],
    success: "Resource status updated.",
    task: () =>
      setBookingResourceStatus({
        resourceId: getString(formData, "resourceId"),
        status: getConfigurationStatus(formData),
      }),
  });
}

export async function updateBookingResourceProfileAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/staff?tab=resources",
    revalidatePaths: [
      "/admin/staff",
      "/admin/offerings",
      "/admin/schedules",
      "/admin/setup",
    ],
    success: "Resource profile updated.",
    task: () =>
      updateBookingResourceProfile({
        name: getString(formData, "name"),
        providerPublicSlug: getOptionalString(formData, "providerPublicSlug"),
        providerSanityDocumentId: getOptionalString(
          formData,
          "providerSanityDocumentId",
        ),
        resourceId: getString(formData, "resourceId"),
        timezone: getString(formData, "timezone"),
      }),
  });
}

export async function createBookingServiceAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/offerings?tab=services",
    revalidatePaths: ["/admin/offerings", "/admin/setup", "/services"],
    success: "Service created as a draft.",
    task: () => {
      const sanityLink = getOptionalSanityServiceLink(formData);
      const publicSlug =
        sanityLink.publicSlug ?? getOptionalString(formData, "publicSlug");
      return createBookingService({
        displayTitle: getString(formData, "displayTitle"),
        ownerProviderId: getString(formData, "ownerProviderId"),
        publicSlug,
        sanityDocumentId: sanityLink.sanityDocumentId,
        serviceKey: getString(formData, "serviceKey"),
      });
    },
  });
}

export async function setBookingServiceStatusAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/offerings?tab=services",
    revalidatePaths: ["/admin/offerings", "/admin/setup", "/services"],
    success: "Service status updated.",
    task: () =>
      setBookingServiceStatus({
        serviceId: getString(formData, "serviceId"),
        status: getConfigurationStatus(formData),
      }),
  });
}

export async function updateBookingServiceProfileAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/offerings?tab=services",
    revalidatePaths: ["/admin/offerings", "/admin/setup", "/services"],
    success: "Service profile updated.",
    task: () => {
      const sanityLink = getOptionalSanityServiceLink(formData);
      const publicSlug =
        sanityLink.publicSlug ?? getOptionalString(formData, "publicSlug");
      return updateBookingServiceProfile({
        displayTitle: getString(formData, "displayTitle"),
        publicSlug,
        sanityDocumentId: sanityLink.sanityDocumentId,
        serviceId: getString(formData, "serviceId"),
      });
    },
  });
}

export async function createServiceOfferingAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/offerings?tab=price-timing",
    revalidatePaths: ["/admin/offerings", "/admin/setup", "/services"],
    success: "Provider offering created as a draft.",
    task: () =>
      createServiceOffering({
        bufferAfterMinutes: getInteger(formData, "bufferAfterMinutes"),
        bufferBeforeMinutes: getInteger(formData, "bufferBeforeMinutes"),
        depositAmountCents: getMoneyCents(formData, "depositAmount"),
        displayOrder: getInteger(formData, "displayOrder"),
        durationMinutes: getInteger(formData, "durationMinutes"),
        fullPriceCents: getMoneyCents(formData, "fullPrice"),
        offeringKey: getString(formData, "offeringKey"),
        providerId: getString(formData, "providerId"),
        publicSummary: getString(formData, "publicSummary"),
        publicTitle: getString(formData, "publicTitle"),
        serviceId: getString(formData, "serviceId"),
        slotIntervalMinutes: getInteger(formData, "slotIntervalMinutes"),
      }),
  });
}

export async function setServiceOfferingStatusAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/offerings?tab=price-timing",
    revalidatePaths: ["/admin/offerings", "/admin/setup", "/services"],
    success: "Offering status updated.",
    task: () =>
      setServiceOfferingStatus({
        offeringId: getString(formData, "offeringId"),
        status: getConfigurationStatus(formData),
      }),
  });
}

export async function updateServiceOfferingAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/offerings?tab=price-timing",
    revalidatePaths: ["/admin/offerings", "/admin/setup", "/services"],
    success: "Offering details updated.",
    task: () =>
      updateServiceOffering({
        bufferAfterMinutes: getInteger(formData, "bufferAfterMinutes"),
        bufferBeforeMinutes: getInteger(formData, "bufferBeforeMinutes"),
        depositAmountCents: getMoneyCents(formData, "depositAmount"),
        displayOrder: getInteger(formData, "displayOrder"),
        durationMinutes: getInteger(formData, "durationMinutes"),
        expectedVersion: getInteger(formData, "expectedVersion"),
        fullPriceCents: getMoneyCents(formData, "fullPrice"),
        offeringId: getString(formData, "offeringId"),
        publicSummary: getString(formData, "publicSummary"),
        publicTitle: getString(formData, "publicTitle"),
        slotIntervalMinutes: getInteger(formData, "slotIntervalMinutes"),
      }),
  });
}

export async function assignOfferingResourceAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/offerings?tab=price-timing",
    revalidatePaths: ["/admin/offerings", "/admin/setup", "/services"],
    success: "Offering resource saved.",
    task: () =>
      assignOfferingResource({
        isRequired: getString(formData, "isRequired") === "true",
        offeringId: getString(formData, "offeringId"),
        resourceId: getString(formData, "resourceId"),
      }),
  });
}

export async function removeOfferingResourceAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/offerings?tab=price-timing",
    revalidatePaths: ["/admin/offerings", "/admin/setup", "/services"],
    success: "Offering resource removed for future holds.",
    task: () =>
      removeOfferingResource({
        offeringId: getString(formData, "offeringId"),
        resourceId: getString(formData, "resourceId"),
      }),
  });
}

export async function createOfferingAddOnAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/offerings?tab=add-ons",
    revalidatePaths: ["/admin/offerings", "/services"],
    success: "Add-on created.",
    task: () =>
      createOfferingAddOn({
        addOnKey: getString(formData, "addOnKey"),
        description: getString(formData, "description"),
        durationDeltaMinutes: getInteger(formData, "durationDeltaMinutes"),
        name: getString(formData, "name"),
        offeringId: getString(formData, "offeringId"),
        priceCents: getMoneyCents(formData, "price"),
      }),
  });
}

export async function setOfferingAddOnStatusAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/offerings?tab=add-ons",
    revalidatePaths: ["/admin/offerings", "/services"],
    success: "Add-on status updated.",
    task: async () => {
      const status = getString(formData, "status");
      if (status !== "active" && status !== "disabled") {
        throw new Error("Invalid add-on status");
      }
      await setOfferingAddOnStatus({
        addOnId: getString(formData, "addOnId"),
        status,
      });
    },
  });
}

export async function updateBookingSettingsAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/booking-settings",
    revalidatePaths: ["/admin", "/admin/booking-settings", "/admin/setup"],
    success: "Booking defaults saved.",
    task: () =>
      updateBookingSettings({
        bookingHorizonDays: getInteger(formData, "bookingHorizonDays"),
        defaultBufferAfterMinutes: getInteger(
          formData,
          "defaultBufferAfterMinutes",
        ),
        defaultBufferBeforeMinutes: getInteger(
          formData,
          "defaultBufferBeforeMinutes",
        ),
        intakeQuestions: parseOperationalBookingQuestionsJson(
          getString(formData, "intakeQuestions"),
        ),
        marketingOptInLabel: getString(formData, "marketingOptInLabel"),
        minimumLeadTimeHours: getInteger(formData, "minimumLeadTimeHours"),
        slotIntervalMinutes: getInteger(formData, "slotIntervalMinutes"),
        timezone: getString(formData, "timezone"),
      }),
  });
}

export async function createResourceScheduleAction(formData: FormData) {
  const returnResourceId = getOptionalString(formData, "resourceId") ?? "";
  return runAdminAction({
    destination: availabilityDestination("hours", returnResourceId),
    revalidatePaths: ["/admin/schedules", "/admin/setup"],
    success: "Weekly hours added.",
    task: () =>
      createResourceSchedule({
        effectiveFrom: getString(formData, "effectiveFrom"),
        effectiveUntil: getOptionalString(formData, "effectiveUntil"),
        endsAt: getString(formData, "endsAt"),
        resourceId: getString(formData, "resourceId"),
        startsAt: getString(formData, "startsAt"),
        weekday: getInteger(formData, "weekday"),
      }),
  });
}

export async function disableResourceScheduleAction(formData: FormData) {
  const returnResourceId = getOptionalString(formData, "resourceId") ?? "";
  return runAdminAction({
    destination: availabilityDestination("hours", returnResourceId),
    revalidatePaths: ["/admin/schedules", "/admin/setup"],
    success: "Weekly hours disabled.",
    task: () =>
      disableResourceSchedule({
        resourceId: getString(formData, "resourceId"),
        scheduleId: getString(formData, "scheduleId"),
      }),
  });
}

export async function createScheduleExceptionAction(formData: FormData) {
  const returnResourceId = getOptionalString(formData, "resourceId") ?? "";
  return runAdminAction({
    destination: availabilityDestination("exceptions", returnResourceId),
    revalidatePaths: ["/admin/schedules"],
    success: "Schedule exception added.",
    task: async () => {
      const kind = getString(formData, "kind");
      if (kind !== "available" && kind !== "unavailable") {
        throw new Error("Invalid exception type");
      }
      await createScheduleException({
        endsAtLocal: getString(formData, "endsAtLocal"),
        kind,
        note: getOptionalString(formData, "note"),
        resourceId: getString(formData, "resourceId"),
        startsAtLocal: getString(formData, "startsAtLocal"),
      });
    },
  });
}

export async function cancelScheduleExceptionAction(formData: FormData) {
  const returnResourceId = getOptionalString(formData, "resourceId") ?? "";
  return runAdminAction({
    destination: availabilityDestination("exceptions", returnResourceId),
    revalidatePaths: ["/admin/schedules"],
    success: "Schedule exception cancelled.",
    task: () =>
      cancelScheduleException({
        exceptionId: getString(formData, "exceptionId"),
        resourceId: getString(formData, "resourceId"),
      }),
  });
}

export async function createCalendarConnectionAction() {
  const outcome = await attemptAdminAction(createCalendarConnection);
  if (!outcome.ok) {
    redirect(
      feedbackUrl("/admin/calendar-connections", "error", outcome.error),
    );
  }
  redirect(
    `/api/admin/calendar-connections/${outcome.value.id}/oauth/start?returnTo=/admin/calendar-connections`,
  );
}

export async function disableCalendarConnectionAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/calendar-connections",
    revalidatePaths: ["/admin/calendar-connections", "/admin/setup"],
    success: "Calendar connection disabled.",
    task: () => disableCalendarConnection(getString(formData, "connectionId")),
  });
}

export async function saveCalendarAssignmentAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/calendar-connections",
    revalidatePaths: ["/admin/calendar-connections", "/admin/setup"],
    success: "Calendar assignment saved.",
    task: () => {
      const assignmentRole = getString(formData, "assignmentRole");
      if (
        assignmentRole !== "busy_only" &&
        assignmentRole !== "booking_destination"
      ) {
        throw new Error("Choose how this calendar is used");
      }
      return saveCalendarAssignment({
        acceptsBookings: assignmentRole === "booking_destination",
        calendarLabel: getOptionalString(formData, "calendarLabel"),
        confirmedReplacementAssignmentId: getOptionalString(
          formData,
          "confirmedReplacementAssignmentId",
        ),
        connectionId: getString(formData, "connectionId"),
        contributesBusy: true,
        providerCalendarId: getString(formData, "providerCalendarId"),
        resourceId: getString(formData, "resourceId"),
      });
    },
  });
}

export async function disableCalendarAssignmentAction(formData: FormData) {
  return runAdminAction({
    destination: "/admin/calendar-connections",
    revalidatePaths: ["/admin/calendar-connections", "/admin/setup"],
    success: "Calendar assignment disabled.",
    task: () => disableCalendarAssignment(getString(formData, "assignmentId")),
  });
}

export async function transferCalendarConnectionOwnershipAction(
  formData: FormData,
) {
  return runAdminAction({
    destination: "/admin/calendar-connections",
    revalidatePaths: [
      "/admin/calendar-connections",
      "/admin/my-calendar",
      "/admin/staff",
    ],
    success: "Calendar connection ownership updated.",
    task: () =>
      transferCalendarConnectionOwnership({
        connectionId: getString(formData, "connectionId"),
        employeeUserId: getOptionalString(formData, "employeeUserId") ?? null,
      }),
  });
}

export async function createMyCalendarConnectionAction(formData: FormData) {
  const resourceId = getString(formData, "resourceId");
  const outcome = await attemptAdminAction(() =>
    createEmployeeCalendarConnection(resourceId),
  );
  if (!outcome.ok) {
    redirect(
      feedbackUrl(
        myAvailabilityDestination(resourceId),
        "error",
        outcome.error,
      ),
    );
  }
  redirect(
    `/api/admin/my-calendar/connections/${outcome.value.id}/oauth/start?resourceId=${encodeURIComponent(resourceId)}`,
  );
}

export async function reconnectMyCalendarConnectionAction(formData: FormData) {
  const connectionId = getString(formData, "connectionId");
  const resourceId = getString(formData, "resourceId");
  redirect(
    `/api/admin/my-calendar/connections/${encodeURIComponent(connectionId)}/oauth/start?resourceId=${encodeURIComponent(resourceId)}`,
  );
}

export async function saveMyCalendarAssignmentAction(formData: FormData) {
  const returnResourceId = getOptionalString(formData, "resourceId") ?? "";
  return runAdminAction({
    destination: myAvailabilityDestination(returnResourceId),
    revalidatePaths: ["/admin/my-calendar", "/admin/calendar-connections"],
    success: "Busy calendar assignment saved.",
    task: () =>
      saveEmployeeBusyAssignment({
        calendarLabel: getOptionalString(formData, "calendarLabel"),
        connectionId: getString(formData, "connectionId"),
        providerCalendarId: getString(formData, "providerCalendarId"),
        resourceId: getString(formData, "resourceId"),
      }),
  });
}

export async function disableMyCalendarAssignmentAction(formData: FormData) {
  const returnResourceId = getOptionalString(formData, "resourceId") ?? "";
  return runAdminAction({
    destination: myAvailabilityDestination(returnResourceId),
    revalidatePaths: ["/admin/my-calendar", "/admin/calendar-connections"],
    success: "Busy calendar assignment removed.",
    task: () =>
      disableEmployeeBusyAssignment({
        assignmentId: getString(formData, "assignmentId"),
        resourceId: getString(formData, "resourceId"),
      }),
  });
}

export async function disconnectMyCalendarConnectionAction(formData: FormData) {
  const returnResourceId = getOptionalString(formData, "resourceId") ?? "";
  return runAdminAction({
    destination: myAvailabilityDestination(returnResourceId),
    revalidatePaths: [
      "/admin/my-calendar",
      "/admin/calendar-connections",
      "/admin/setup",
    ],
    success: "Google Calendar account disconnected.",
    task: () =>
      disconnectEmployeeCalendarConnection({
        connectionId: getString(formData, "connectionId"),
        resourceId: getString(formData, "resourceId"),
      }),
  });
}

interface AdminActionInput {
  destination: string;
  revalidatePaths: string[];
  success: string;
  task: () => Promise<unknown>;
}

async function runAdminAction(input: AdminActionInput): Promise<never> {
  const outcome = await attemptAdminAction(input.task);
  if (!outcome.ok) {
    redirect(feedbackUrl(input.destination, "error", outcome.error));
  }

  for (const path of input.revalidatePaths) revalidatePath(path);
  redirect(feedbackUrl(input.destination, "notice", input.success));
}

async function attemptAdminAction<T>(
  task: () => Promise<T>,
): Promise<{ ok: true; value: T } | { error: string; ok: false }> {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    return { error: friendlyActionError(error), ok: false };
  }
}

function friendlyActionError(error: unknown): string {
  if (error instanceof AdminAuthError) {
    return "You do not have permission to make that change.";
  }

  const postgresCode = getPostgresErrorCode(error);
  if (postgresCode === "23505")
    return "That key, slug, email, or assignment is already in use.";
  if (postgresCode === "23503")
    return "That record is still in use and cannot be changed this way.";

  if (error instanceof Error) {
    const message = error.message.trim();
    const looksInternal =
      /(?:duplicate key|constraint|database|drizzle|insert into|query|relation|sql|stack|token|credential)/i.test(
        message,
      );
    if (
      message &&
      message.length <= 280 &&
      !message.includes("\n") &&
      !looksInternal
    ) {
      return message;
    }
  }

  return "The change could not be saved. No partial update was committed.";
}

function feedbackUrl(
  destination: string,
  kind: "error" | "notice",
  message: string,
): string {
  const query = new URLSearchParams({
    [kind]: toContractorTerminology(message),
  });
  return `${destination}${destination.includes("?") ? "&" : "?"}${query.toString()}`;
}

function availabilityDestination(
  tab: "exceptions" | "hours",
  resourceId: string,
): string {
  const query = new URLSearchParams({ tab });
  if (resourceId) query.set("resource", resourceId);
  return `/admin/schedules?${query.toString()}`;
}

function myAvailabilityDestination(resourceId: string): string {
  if (!resourceId) return "/admin/my-calendar";
  return `/admin/my-calendar?${new URLSearchParams({ resource: resourceId }).toString()}`;
}

function getString(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value.trim();
}

function getOptionalString(
  formData: FormData,
  name: string,
): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getOptionalSanityServiceLink(formData: FormData): {
  publicSlug?: string;
  sanityDocumentId?: string;
} {
  const encoded = getOptionalString(formData, "sanityServiceLink");

  if (!encoded) {
    return {};
  }

  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("Select a valid published Sanity service");
  }

  if (
    typeof value !== "object" ||
    value === null ||
    !("publicSlug" in value) ||
    !("sanityDocumentId" in value) ||
    typeof value.publicSlug !== "string" ||
    typeof value.sanityDocumentId !== "string" ||
    !value.publicSlug.trim() ||
    !value.sanityDocumentId.trim()
  ) {
    throw new Error("Select a valid published Sanity service");
  }

  return {
    publicSlug: value.publicSlug.trim(),
    sanityDocumentId: value.sanityDocumentId.trim(),
  };
}

function getInteger(formData: FormData, name: string): number {
  const value = getString(formData, name);
  if (!/^-?\d+$/.test(value)) throw new Error(`${name} must be a whole number`);
  return Number(value);
}

function getMoneyCents(formData: FormData, name: string): number {
  const value = getString(formData, name);
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error(`${name} must be a valid amount`);
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

function getConfigurationStatus(formData: FormData) {
  const status = getString(formData, "status");
  if (status !== "draft" && status !== "active" && status !== "disabled") {
    throw new Error("Invalid configuration status");
  }
  return status;
}

function getPostgresErrorCode(error: unknown): string | null {
  let candidate = error;
  for (let depth = 0; depth < 5 && candidate !== null; depth += 1) {
    if (typeof candidate !== "object") return null;
    if ("code" in candidate && typeof candidate.code === "string") {
      return candidate.code;
    }
    candidate = "cause" in candidate ? candidate.cause : null;
  }
  return null;
}
