"use client";

import { AdminErrorState } from "@/components/admin/admin-error-state";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <AdminErrorState error={error} reset={reset} standalone />;
}
