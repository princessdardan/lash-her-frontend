"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useFormStatus } from "react-dom";

interface AdminSubmitButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "type"
> {
  children: ReactNode;
  pendingLabel: string;
}

export function AdminSubmitButton({
  children,
  disabled,
  pendingLabel,
  ...props
}: AdminSubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <button
      {...props}
      aria-disabled={pending || disabled}
      disabled={pending || disabled}
      type="submit"
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
