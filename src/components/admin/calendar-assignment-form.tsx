"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import { canGoogleCalendarAcceptBookings } from "@/lib/admin/calendar-capabilities";
import { getGoogleCalendarAccessRoleLabel } from "@/lib/admin/presentation";

export interface CalendarAssignmentResourceOption {
  id: string;
  name: string;
}

export interface CalendarAssignmentCalendarOption {
  accessRole: string;
  id: string;
  label: string;
  primary: boolean;
}

export interface CurrentBookingDestinationOption {
  assignmentId: string;
  calendarLabel: string;
  connectionId: string;
  connectionLabel: string;
  providerCalendarId: string;
  resourceId: string;
  resourceName: string;
}

interface CalendarAssignmentFormProps {
  action: (formData: FormData) => void | Promise<void>;
  calendars: CalendarAssignmentCalendarOption[];
  connectionId: string;
  connectionLabel: string;
  currentDestinations: CurrentBookingDestinationOption[];
  resources: CalendarAssignmentResourceOption[];
}

type AssignmentRole = "booking_destination" | "busy_only";

export interface CalendarDestinationReplacementApproval {
  currentAssignmentId: string;
  targetCalendarId: string;
  targetConnectionId: string;
  targetResourceId: string;
}

interface CalendarDestinationReplacementConfirmation extends CalendarDestinationReplacementApproval {
  currentCalendarLabel: string;
  currentConnectionLabel: string;
  newCalendarLabel: string;
  newConnectionLabel: string;
  resourceName: string;
}

export function CalendarAssignmentForm({
  action,
  calendars,
  connectionId,
  connectionLabel,
  currentDestinations,
  resources,
}: CalendarAssignmentFormProps) {
  const initialResourceId = resources[0]?.id ?? "";
  const initialCalendarId = calendars[0]?.id ?? "";
  const initialTargetsCurrentDestination = targetsCurrentDestination({
    calendarId: initialCalendarId,
    connectionId,
    currentDestinations,
    resourceId: initialResourceId,
  });
  const [resourceId, setResourceId] = useState(initialResourceId);
  const [calendarId, setCalendarId] = useState(initialCalendarId);
  const [assignmentRole, setAssignmentRole] = useState<AssignmentRole>(
    initialTargetsCurrentDestination ? "booking_destination" : "busy_only",
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [replacementConfirmation, setReplacementConfirmation] =
    useState<CalendarDestinationReplacementConfirmation | null>(null);
  const [replacementDialogOpen, setReplacementDialogOpen] = useState(false);
  const [confirmingReplacement, setConfirmingReplacement] = useState(false);
  const approvedReplacementRef =
    useRef<CalendarDestinationReplacementApproval | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const replacementInputRef = useRef<HTMLInputElement>(null);
  const roleDescriptionId = useId();
  const errorId = useId();

  const currentDestination =
    currentDestinations.find(
      (destination) => destination.resourceId === resourceId,
    ) ?? null;
  const selectedCalendar =
    calendars.find((calendar) => calendar.id === calendarId) ?? null;
  const selectedResource =
    resources.find((resource) => resource.id === resourceId) ?? null;
  const isCurrentDestination =
    currentDestination !== null &&
    currentDestination.connectionId === connectionId &&
    currentDestination.providerCalendarId === calendarId;
  const selectedCalendarCanReceiveBookings =
    selectedCalendar !== null &&
    canGoogleCalendarAcceptBookings(selectedCalendar.accessRole);
  const mustReconnectCurrentDestination =
    isCurrentDestination && !selectedCalendarCanReceiveBookings;

  function resetReplacementApproval() {
    approvedReplacementRef.current = null;
    if (replacementInputRef.current) {
      replacementInputRef.current.value = "";
    }
  }

  function selectResource(nextResourceId: string) {
    resetReplacementApproval();
    setResourceId(nextResourceId);
    setFormError(null);
    updateRoleForTarget(nextResourceId, calendarId);
  }

  function selectCalendar(nextCalendarId: string) {
    resetReplacementApproval();
    setCalendarId(nextCalendarId);
    setFormError(null);
    updateRoleForTarget(resourceId, nextCalendarId);
  }

  function updateRoleForTarget(nextResourceId: string, nextCalendarId: string) {
    if (
      targetsCurrentDestination({
        calendarId: nextCalendarId,
        connectionId,
        currentDestinations,
        resourceId: nextResourceId,
      })
    ) {
      setAssignmentRole("booking_destination");
      return;
    }
    const nextCalendar = calendars.find(
      (calendar) => calendar.id === nextCalendarId,
    );
    if (
      !nextCalendar ||
      !canGoogleCalendarAcceptBookings(nextCalendar.accessRole)
    ) {
      setAssignmentRole("busy_only");
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    setFormError(null);

    if (isCurrentDestination && assignmentRole === "busy_only") {
      event.preventDefault();
      resetReplacementApproval();
      setFormError(
        "Move the booking destination before changing this calendar to busy-only.",
      );
      return;
    }
    if (
      assignmentRole === "booking_destination" &&
      !selectedCalendarCanReceiveBookings
    ) {
      event.preventDefault();
      resetReplacementApproval();
      setFormError(
        "This Google calendar needs writer or owner access to receive bookings.",
      );
      return;
    }
    if (
      assignmentRole !== "booking_destination" ||
      currentDestination === null ||
      isCurrentDestination
    ) {
      resetReplacementApproval();
      return;
    }

    const requestedReplacement: CalendarDestinationReplacementApproval = {
      currentAssignmentId: currentDestination.assignmentId,
      targetCalendarId: calendarId,
      targetConnectionId: connectionId,
      targetResourceId: resourceId,
    };
    if (
      isCalendarDestinationReplacementApprovalExact(
        approvedReplacementRef.current,
        requestedReplacement,
      )
    ) {
      if (replacementInputRef.current) {
        replacementInputRef.current.value =
          requestedReplacement.currentAssignmentId;
      }
      approvedReplacementRef.current = null;
      return;
    }

    event.preventDefault();
    resetReplacementApproval();
    setReplacementConfirmation({
      ...requestedReplacement,
      currentCalendarLabel: currentDestination.calendarLabel,
      currentConnectionLabel: currentDestination.connectionLabel,
      newCalendarLabel: selectedCalendar?.label ?? "the selected calendar",
      newConnectionLabel: connectionLabel,
      resourceName: currentDestination.resourceName,
    });
    setReplacementDialogOpen(true);
  }

  function handleReplacementDialogOpenChange(nextOpen: boolean) {
    if (confirmingReplacement) return;
    setReplacementDialogOpen(nextOpen);
    if (!nextOpen) {
      resetReplacementApproval();
      setReplacementConfirmation(null);
    }
  }

  function confirmReplacement() {
    if (!replacementConfirmation || !currentDestination || !formRef.current) {
      return;
    }
    const currentRequest: CalendarDestinationReplacementApproval = {
      currentAssignmentId: currentDestination.assignmentId,
      targetCalendarId: calendarId,
      targetConnectionId: connectionId,
      targetResourceId: resourceId,
    };
    if (
      !isCalendarDestinationReplacementApprovalExact(
        replacementConfirmation,
        currentRequest,
      )
    ) {
      setReplacementDialogOpen(false);
      setReplacementConfirmation(null);
      resetReplacementApproval();
      setFormError(
        "The selected resource or calendar changed. Review the booking destination and try again.",
      );
      return;
    }
    if (!formRef.current.reportValidity()) {
      setReplacementDialogOpen(false);
      setReplacementConfirmation(null);
      resetReplacementApproval();
      return;
    }

    approvedReplacementRef.current = currentRequest;
    if (replacementInputRef.current) {
      replacementInputRef.current.value = currentRequest.currentAssignmentId;
    }
    setConfirmingReplacement(true);
    formRef.current.requestSubmit();
  }

  return (
    <form
      action={action}
      className="mt-6 rounded-2xl bg-lh-neutral-2 p-4"
      onSubmit={handleSubmit}
      ref={formRef}
    >
      <h3 className="font-semibold">Assign calendar</h3>
      <input name="connectionId" type="hidden" value={connectionId} />
      <input
        name="confirmedReplacementAssignmentId"
        ref={replacementInputRef}
        type="hidden"
      />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Provider">
          <select
            className={inputClass}
            name="resourceId"
            onChange={(event) => selectResource(event.target.value)}
            required
            value={resourceId}
          >
            {resources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Google calendar">
          <select
            className={inputClass}
            name="providerCalendarId"
            onChange={(event) => selectCalendar(event.target.value)}
            required
            value={calendarId}
          >
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.label}
                {calendar.primary ? " (primary)" : ""} ·{" "}
                {getGoogleCalendarAccessRoleLabel(calendar.accessRole)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Calendar name">
          <input className={inputClass} name="calendarLabel" />
        </Field>
      </div>

      <fieldset
        aria-describedby={
          formError ? `${roleDescriptionId} ${errorId}` : roleDescriptionId
        }
        className="mt-4 space-y-2"
      >
        <legend className="text-sm font-semibold">Calendar role</legend>
        <label className="flex min-h-11 items-center gap-3 rounded-xl border border-lh-line bg-white px-3 py-2 text-sm">
          <input
            checked={assignmentRole === "busy_only"}
            disabled={isCurrentDestination}
            name="assignmentRole"
            onChange={() => {
              resetReplacementApproval();
              setAssignmentRole("busy_only");
            }}
            type="radio"
            value="busy_only"
          />
          Blocks busy time only
        </label>
        <label className="flex min-h-11 items-center gap-3 rounded-xl border border-lh-line bg-white px-3 py-2 text-sm">
          <input
            checked={assignmentRole === "booking_destination"}
            disabled={!selectedCalendarCanReceiveBookings}
            name="assignmentRole"
            onChange={() => {
              resetReplacementApproval();
              setAssignmentRole("booking_destination");
            }}
            type="radio"
            value="booking_destination"
          />
          Receives bookings and blocks busy time
        </label>
        <p className="text-xs text-lh-muted" id={roleDescriptionId}>
          {isCurrentDestination
            ? "This is the current booking destination. Move bookings to another calendar before making it busy-only."
            : currentDestination
              ? `New bookings for ${currentDestination.resourceName} currently go to ${currentDestination.calendarLabel}. Choosing “Receives bookings” requires confirmation.`
              : "Choose one booking destination per resource. Every assigned calendar blocks its own busy time."}
        </p>
      </fieldset>

      {mustReconnectCurrentDestination ? (
        <p className="mt-3 text-sm text-red-700" role="alert">
          This booking destination no longer has Google write access. Reconnect
          the account or choose another writable calendar.
        </p>
      ) : null}
      {formError ? (
        <p className="mt-3 text-sm text-red-700" id={errorId} role="alert">
          {formError}
        </p>
      ) : null}

      <SubmitButton
        disabled={
          resources.length === 0 ||
          calendars.length === 0 ||
          mustReconnectCurrentDestination ||
          replacementDialogOpen ||
          confirmingReplacement
        }
      />
      <ReplacementConfirmationDialog
        confirmation={replacementConfirmation}
        confirming={confirmingReplacement}
        onConfirm={confirmReplacement}
        onOpenChange={handleReplacementDialogOpenChange}
        open={replacementDialogOpen}
      />
      {selectedResource === null ? (
        <p className="mt-3 text-sm text-red-700" role="alert">
          Choose a provider.
        </p>
      ) : null}
    </form>
  );
}

function ReplacementConfirmationDialog({
  confirmation,
  confirming,
  onConfirm,
  onOpenChange,
  open,
}: {
  confirmation: CalendarDestinationReplacementConfirmation | null;
  confirming: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { pending } = useFormStatus();
  const busy = pending || confirming;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-lh-shadow/50 backdrop-blur-sm data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-lh-line bg-white p-6 shadow-2xl focus:outline-none sm:p-8">
          <Dialog.Title className="font-heading text-3xl uppercase tracking-[0.08em] text-lh-shadow">
            Move booking destination?
          </Dialog.Title>
          <Dialog.Description className="mt-3 leading-7 text-lh-muted">
            {confirmation ? (
              <>
                New bookings for{" "}
                <strong className="text-lh-shadow">
                  {confirmation.resourceName}
                </strong>{" "}
                currently go to{" "}
                <strong className="text-lh-shadow">
                  {confirmation.currentCalendarLabel}
                </strong>{" "}
                through {confirmation.currentConnectionLabel}. They will instead
                go to{" "}
                <strong className="text-lh-shadow">
                  {confirmation.newCalendarLabel}
                </strong>{" "}
                through {confirmation.newConnectionLabel}. Existing appointments
                are unchanged.
              </>
            ) : (
              "Review the current and new booking calendars before continuing."
            )}
          </Dialog.Description>
          <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Dialog.Close asChild>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-full border border-lh-line px-5 py-2 text-sm font-semibold text-lh-shadow transition hover:bg-lh-neutral-2 disabled:opacity-60"
                disabled={busy}
                type="button"
              >
                Keep current destination
              </button>
            </Dialog.Close>
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-full bg-lh-accent px-5 py-2 text-sm font-semibold text-white transition hover:bg-lh-shadow disabled:cursor-wait disabled:opacity-60"
              disabled={busy || confirmation === null}
              onClick={onConfirm}
              type="button"
            >
              {busy ? "Moving…" : "Move booking destination"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      className={`${primaryButtonClass} mt-4 disabled:cursor-not-allowed disabled:opacity-50`}
      disabled={disabled || pending}
      type="submit"
    >
      {pending ? "Saving…" : "Save assignment"}
    </button>
  );
}

function Field({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <label className="block text-sm font-semibold">
      <span className="mb-2 block">{label}</span>
      {children}
    </label>
  );
}

function targetsCurrentDestination(input: {
  calendarId: string;
  connectionId: string;
  currentDestinations: CurrentBookingDestinationOption[];
  resourceId: string;
}): boolean {
  return input.currentDestinations.some(
    (destination) =>
      destination.resourceId === input.resourceId &&
      destination.connectionId === input.connectionId &&
      destination.providerCalendarId === input.calendarId,
  );
}

export function isCalendarDestinationReplacementApprovalExact(
  approved: CalendarDestinationReplacementApproval | null,
  requested: CalendarDestinationReplacementApproval,
): boolean {
  return (
    approved !== null &&
    approved.currentAssignmentId === requested.currentAssignmentId &&
    approved.targetCalendarId === requested.targetCalendarId &&
    approved.targetConnectionId === requested.targetConnectionId &&
    approved.targetResourceId === requested.targetResourceId
  );
}

const inputClass =
  "min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm";
const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-white";
