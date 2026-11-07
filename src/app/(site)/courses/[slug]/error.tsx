"use client";

import { Button } from "@/components/ui/button";

export default function CourseError({ reset }: { reset: () => void }) {
  return (
    <section className="mx-auto max-w-2xl px-6 py-20 text-lh-shadow">
      <h1 className="font-heading text-4xl">The course could not load</h1>
      <p className="my-6">
        Please try again. If the learning service is unavailable, return later.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}
