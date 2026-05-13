import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-lh-line placeholder:text-lh-muted focus-visible:border-lh-primary focus-visible:ring-lh-primary/50 aria-invalid:ring-lh-accent/20 dark:aria-invalid:ring-lh-accent/40 aria-invalid:border-lh-accent dark:bg-input/30 flex field-sizing-content min-h-28 w-full rounded-[18px] border bg-lh-white px-4 py-3 text-base text-lh-shadow shadow-sm transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
