"use client";

import { useState } from "react";

import { courseProgressKey } from "@/lib/courses/progress";
import type { CourseAccessGrant } from "@/lib/courses/contract";
import { legacyPracticeProgress } from "@/lib/courses/legacy-progress-transfer";
import { learningSecondaryAction } from "./shared";

export function LegacyProgressImport({ courseId, grant }: { courseId: string; grant: CourseAccessGrant }) {
  const [status, setStatus] = useState<"ready" | "pending" | "missing" | "success" | "error">("ready");

  async function importProgress() {
    setStatus("pending");
    try {
      const progress = legacyPracticeProgress(localStorage.getItem(courseProgressKey(grant)), grant);
      if (!progress) {
        setStatus("missing");
        return;
      }
      const response = await fetch(`/api/academy/courses/${courseId}/legacy-progress`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lash-csrf": "1" },
        body: JSON.stringify(progress),
      });
      setStatus(response.ok ? "success" : "error");
    } catch {
      setStatus("error");
    }
  }

  return <div className="mt-4">
    <button type="button" className={learningSecondaryAction} onClick={importProgress} disabled={status === "pending" || status === "success"}>
      {status === "pending" ? "Importing progress…" : "Import progress from this browser"}
    </button>
    <p role="status" className="mt-2 text-sm">
      {status === "missing" ? "No saved practice progress was found in this browser." :
        status === "success" ? "Import checked. Any existing course progress was kept." :
        status === "error" ? "Progress could not be imported. You can still open the course." : ""}
    </p>
  </div>;
}
