import MuxPlayer from "@mux/mux-player-react/lazy";

export const TRAINING_PROGRAM_PREVIEW_ID = "program-preview";

interface TrainingProgramPreviewProps {
  readonly playbackId: string;
  readonly programTitle: string;
  readonly thumbTime?: number;
}

export function TrainingProgramPreview({
  playbackId,
  programTitle,
  thumbTime,
}: TrainingProgramPreviewProps) {
  return (
    <section
      id={TRAINING_PROGRAM_PREVIEW_ID}
      aria-labelledby="program-preview-title"
      tabIndex={-1}
      className="mx-auto grid max-w-[660px] scroll-mt-32 gap-4 border-b border-lh-line pb-8 lg:max-w-none lg:grid-cols-[minmax(9rem,0.45fr)_minmax(0,1fr)] lg:items-center lg:gap-7"
    >
      <h2 id="program-preview-title" className="section-heading">
        Program preview
      </h2>
      <div className="min-w-0 overflow-hidden rounded-2xl border border-lh-line bg-lh-shadow shadow-md">
        <MuxPlayer
          key={playbackId}
          playbackId={playbackId}
          videoTitle={`${programTitle} preview`}
          aria-label={`${programTitle} preview`}
          streamType="on-demand"
          thumbnailTime={thumbTime}
          loading="viewport"
          preload="metadata"
          playsInline
          accentColor="var(--lh-light)"
          disableTracking
          disableCookies
          className="block aspect-video w-full"
        />
      </div>
    </section>
  );
}
