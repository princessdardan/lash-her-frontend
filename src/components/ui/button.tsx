import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-bold transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-lh-primary focus-visible:ring-lh-primary/50 focus-visible:ring-[3px] aria-invalid:ring-lh-accent/20 dark:aria-invalid:ring-lh-accent/40 aria-invalid:border-lh-accent",
  {
    variants: {
      variant: {
        default: "bg-lh-primary text-lh-white hover:bg-lh-primary/90",
        destructive:
          "bg-lh-accent text-lh-white hover:bg-lh-accent/90 focus-visible:ring-lh-accent/20 dark:focus-visible:ring-lh-accent/40 dark:bg-lh-accent/60",
        outline:
          "border border-lh-line bg-background shadow-xs hover:bg-lh-neutral hover:text-lh-shadow dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-lh-neutral text-lh-shadow hover:bg-lh-neutral/80",
        ghost:
          "bg-transparent text-lh-accent border border-lh-accent/30 hover:bg-lh-accent/5",
        link: "text-lh-primary underline-offset-4 hover:underline",
        primary: "bg-lh-primary text-lh-white hover:bg-lh-primary/90",
        dark: "bg-lh-shadow text-lh-neutral hover:bg-lh-shadow/90",
        luxury: "bg-lh-light text-lh-shadow hover:bg-lh-light/90",
        accent: "bg-lh-accent text-lh-white hover:bg-lh-accent/90",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
