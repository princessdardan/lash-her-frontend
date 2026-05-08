import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-lh-muted selection:bg-lh-primary selection:text-lh-white dark:bg-input/30 border-lh-line h-11 w-full min-w-0 rounded-[18px] border bg-lh-white px-4 py-2 text-base text-lh-shadow shadow-sm transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-bold disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-lh-primary focus-visible:ring-lh-primary/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-lh-accent/20 dark:aria-invalid:ring-lh-accent/40 aria-invalid:border-lh-accent",
        className
      )}
      {...props}
    />
  )
}

export { Input }
