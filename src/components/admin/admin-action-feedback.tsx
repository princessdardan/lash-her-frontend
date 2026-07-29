import { toContractorTerminology } from "@/lib/admin/presentation";

interface AdminActionFeedbackProps {
  error?: string | string[];
  notice?: string | string[];
}

export function AdminActionFeedback({
  error,
  notice,
}: AdminActionFeedbackProps) {
  const errorMessage = firstMessage(error);
  const noticeMessage = firstMessage(notice);

  if (!errorMessage && !noticeMessage) return null;

  return (
    <div
      aria-live="polite"
      className={
        errorMessage
          ? "rounded-2xl border border-red-300 bg-red-50 p-4 text-sm text-red-900"
          : "rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-950"
      }
      role={errorMessage ? "alert" : "status"}
    >
      {errorMessage ?? noticeMessage}
    </div>
  );
}

function firstMessage(value: string | string[] | undefined): string | null {
  const message = Array.isArray(value) ? value[0] : value;
  return message ? toContractorTerminology(message).slice(0, 300) : null;
}
