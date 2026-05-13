"use client";

import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

interface ScrollToFormProps {
  formId: string;
}

export function ScrollToForm({ formId }: ScrollToFormProps) {
  const searchParams = useSearchParams();
  const formParam = searchParams.get("form");

  useEffect(() => {
    if (formParam !== formId) return;

    const timeout = setTimeout(() => {
      const element = document.getElementById(formId);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [formParam, formId]);

  return null;
}
