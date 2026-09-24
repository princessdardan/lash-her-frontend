"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { MuxPlayerRefAttributes } from "@mux/mux-player-react";
import type { TCourseModule } from "@/types";

const MuxPlayer = lazy(() => import("@mux/mux-player-react"));

export function CourseVideo({
  lessonModule,
  position,
  onPosition,
}: {
  lessonModule: TCourseModule;
  position: number;
  onPosition: (position: number) => void;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const lastSaved = useRef(position);
  const seeking = useRef(false);
  const videoRef = useRef<HTMLVideoElement | MuxPlayerRefAttributes | null>(
    null,
  );
  useEffect(() => {
    const savePosition = () => {
      if (videoRef.current?.readyState)
        onPosition(videoRef.current.currentTime);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") savePosition();
    };
    window.addEventListener("pagehide", savePosition);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", savePosition);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [onPosition]);

  const video = lessonModule.video;
  if (
    video.provider === "mux"
      ? video.status !== "ready" || !video.playbackId
      : !video.url
  )
    return (
      <p role="status" className="mt-6 bg-lh-primary/5 p-6 text-sm">
        {video.provider === "mux" && video.status === "preparing"
          ? "This video is still processing. Please check back shortly."
          : "This video is currently unavailable. Please try again later."}
      </p>
    );

  function savePosition() {
    const player = videoRef.current;
    if (player?.readyState) {
      lastSaved.current = player.currentTime;
      onPosition(player.currentTime);
    }
  }

  // Mux exposes the same media properties as the legacy HTML video player.
  // Read through the ref because its callbacks dispatch native CustomEvents.
  const mediaProps = {
    className: "aspect-video w-full bg-black",
    playsInline: true,
    preload: "metadata",
    crossOrigin: "anonymous" as const,
    poster: lessonModule.posterUrl,
    "aria-label": `${lessonModule.title} video`,
    onLoadedMetadata: () => {
      const player = videoRef.current;
      if (player && position > 0 && Number.isFinite(player.duration))
        player.currentTime = Math.min(
          position,
          Math.max(0, player.duration - 0.1),
        );
    },
    onTimeUpdate: () => {
      const player = videoRef.current;
      if (!player?.readyState || seeking.current) return;
      if (Math.abs(player.currentTime - lastSaved.current) >= 5) savePosition();
    },
    onPause: savePosition,
    onSeeking: () => {
      seeking.current = true;
    },
    onSeeked: () => {
      seeking.current = false;
      savePosition();
    },
    onEnded: savePosition,
    onError: () => setFailed(true),
  };
  const captions = lessonModule.captionsUrl ? (
    <track
      key={lessonModule.captionsUrl}
      kind="captions"
      src={lessonModule.captionsUrl}
      srcLang="en"
      label="English"
      default
    />
  ) : null;

  return (
    <div className="mt-6">
      {video.provider === "mux" ? (
        <Suspense
          fallback={
            <div
              role="status"
              className="aspect-video w-full bg-black p-6 text-white"
            >
              Loading video…
            </div>
          }
        >
          <MuxPlayer
            {...mediaProps}
            key={attempt}
            ref={(player) => {
              videoRef.current = player;
            }}
            playbackId={video.playbackId!}
            streamType="on-demand"
            thumbnailTime={video.thumbTime ?? undefined}
            accentColor="var(--color-lh-primary)"
            // Preserve the site's opt-in analytics policy. Playback needs no tracking.
            disableTracking
            disableCookies
          >
            {captions}
          </MuxPlayer>
        </Suspense>
      ) : (
        <video
          {...mediaProps}
          key={attempt}
          ref={(player) => {
            videoRef.current = player;
          }}
          controls
        >
          <source
            key="source"
            src={video.url!}
            type="video/mp4"
            onError={mediaProps.onError}
          />
          {captions}
          Your browser does not support video playback.
        </video>
      )}
      {failed && (
        <div role="alert" className="mt-3 text-sm text-red-800">
          <p>The video could not load. Check your connection and try again.</p>
          <button
            type="button"
            className="mt-2 underline"
            onClick={() => {
              seeking.current = false;
              setAttempt((current) => current + 1);
              setFailed(false);
            }}
          >
            Retry video
          </button>
        </div>
      )}
    </div>
  );
}
