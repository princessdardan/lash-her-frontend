"use client";

interface ConfirmSubmitButtonProps {
  ariaLabel?: string;
  children: React.ReactNode;
  className?: string;
  confirmation: string;
}

export function ConfirmSubmitButton({
  ariaLabel,
  children,
  className,
  confirmation,
}: ConfirmSubmitButtonProps) {
  return (
    <button
      aria-label={ariaLabel}
      className={className}
      onClick={(event) => {
        if (!window.confirm(confirmation)) event.preventDefault();
      }}
      type="submit"
    >
      {children}
    </button>
  );
}
