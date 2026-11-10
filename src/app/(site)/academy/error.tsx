"use client";

import { learningSecondaryAction } from "@/components/learning/shared";

export default function AcademyError({ reset }: { reset: () => void }) {
  return <section className="mx-auto max-w-2xl px-6 py-20 text-lh-shadow"><h1 className="font-heading text-4xl">The lesson could not load</h1><p className="my-6">Try again when the learning service is available.</p><button type="button" className={learningSecondaryAction} onClick={reset}>Try again</button></section>;
}
