"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useFormStatus } from "react-dom";

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
  const { pending } = useFormStatus();
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const busy = pending || submitting;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) setOpen(nextOpen);
      }}
    >
      <Dialog.Trigger asChild>
        <button
          aria-label={ariaLabel}
          className={className}
          disabled={busy}
          onClick={(event) => {
            setForm(event.currentTarget.form);
          }}
          type="button"
        >
          {children}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-lh-shadow/50 backdrop-blur-sm data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-lh-line bg-white p-6 shadow-2xl focus:outline-none sm:p-8">
          <Dialog.Title className="font-heading text-3xl uppercase tracking-[0.08em] text-lh-shadow">
            Confirm this change
          </Dialog.Title>
          <Dialog.Description className="mt-3 leading-7 text-lh-muted">
            {confirmation}
          </Dialog.Description>
          <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Dialog.Close asChild>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-full border border-lh-line px-5 py-2 text-sm font-semibold text-lh-shadow transition hover:bg-lh-neutral-2 disabled:opacity-60"
                disabled={busy}
                type="button"
              >
                Keep unchanged
              </button>
            </Dialog.Close>
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-full bg-lh-accent px-5 py-2 text-sm font-semibold text-white transition hover:bg-lh-shadow disabled:cursor-wait disabled:opacity-60"
              disabled={busy || form === null}
              onClick={() => {
                if (!form) return;
                if (!form.reportValidity()) {
                  setOpen(false);
                  return;
                }

                setSubmitting(true);
                form.requestSubmit();
              }}
              type="button"
            >
              {busy ? "Saving…" : children}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
