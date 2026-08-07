export function PlaybackBoundary({ endpoint }: { endpoint: string }) {
  return (
    <section
      className="rounded-2xl border border-dashed border-lh-primary/40 bg-lh-primary-soft p-6"
      data-playback-endpoint={endpoint}
      aria-label="Lesson video"
    >
      <p className="font-semibold text-lh-shadow">Secure video playback</p>
      <p className="mt-2 text-sm leading-6 text-lh-muted">
        The approved player will request short-lived playback authorization here
        when connected.
      </p>
    </section>
  );
}
