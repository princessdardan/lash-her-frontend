"use client";

import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { MuxPlayerRefAttributes } from "@mux/mux-player-react";
import type {
  LearnerLesson,
  PlaybackAuthorization,
} from "@/lib/learning/types";
import {
  learningErrorText,
  learningRequest,
  LearningRequestError,
} from "@/lib/learning/browser-request";
import { safeLearningUrl } from "@/lib/learning/presentation";
import { playbackLifetime } from "@/lib/learning/playback-lifetime";
import { learningSecondaryAction } from "./shared";

const MuxPlayer = lazy(() => import("@mux/mux-player-react"));
type Media = MuxPlayerRefAttributes;

export function AuthorizedVideo({
  lesson,
  resume,
  onPosition,
  flushPositionRef,
}: {
  lesson: LearnerLesson;
  resume: number;
  onPosition: (resume: number, watched?: number, keepalive?: boolean) => void;
  flushPositionRef?: MutableRefObject<(() => void) | null>;
}) {
  const [authorization, setAuthorization] =
    useState<PlaybackAuthorization | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const player = useRef<Media | null>(null);
  const position = useRef(resume);
  const lastSent = useRef(resume);
  const watched = useRef(0);
  const seeking = useRef(false);
  const observed = useRef(false);
  const onPositionRef = useRef(onPosition);
  useEffect(() => {
    onPositionRef.current = onPosition;
  }, [onPosition]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let busy = false;
    let deadline = 0,
      wallDeadline = 0;
    let expired = false;
    const remaining = () =>
      Math.min(deadline - performance.now(), wallDeadline - Date.now());
    const stop = (error: unknown) => {
      expired = true;
      clearTimeout(timer);
      clearTimeout(expiryTimer);
      request?.abort();
      player.current?.pause();
      setAuthorization(null);
      setFailure(error);
    };
    const expire = () => {
      if (controller.signal.aborted || expired) return;
      if (remaining() > 0) {
        expiryTimer = setTimeout(expire, remaining());
        return;
      }
      expired = true;
      stop(new LearningRequestError("service_unavailable", 503));
    };
    const renew = async () => {
      if (busy || expired || controller.signal.aborted) return;
      busy = true;
      request = new AbortController();
      const activeRequest = request;
      const started = performance.now();
      let serverDate: string | null = null;
      try {
        const result = await learningRequest<PlaybackAuthorization>(
          `/api/academy/lessons/${lesson.id}/playback`,
          {
            signal: AbortSignal.any([controller.signal, activeRequest.signal]),
            onResponse: (response) => {
              serverDate = response.headers.get("date");
            },
          },
        );
        if (
          !result.playbackToken ||
          !result.thumbnailToken ||
          !result.thumbnailExpiresAt
        )
          throw new Error("Incomplete playback authorization");
        const lifetime = playbackLifetime(
          result.expiresAt,
          result.thumbnailExpiresAt,
          {
            serverDate,
            localNow: Date.now(),
            elapsedMs: performance.now() - started,
          },
        );
        if (
          controller.signal.aborted ||
          activeRequest.signal.aborted ||
          expired
        )
          return;
        deadline = performance.now() + lifetime;
        wallDeadline = Date.now() + lifetime;
        clearTimeout(timer);
        clearTimeout(expiryTimer);
        setAuthorization(result);
        setFailure(null);
        expiryTimer = setTimeout(expire, lifetime);
        timer = setTimeout(
          () => {
            void renew();
          },
          Math.max(1000, lifetime - 30_000),
        );
      } catch (error) {
        if (
          !controller.signal.aborted &&
          !activeRequest.signal.aborted &&
          !expired
        )
          stop(error);
      } finally {
        busy = false;
      }
    };
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      if (deadline && remaining() <= 0) expire();
      else if (!deadline || remaining() < 30_000) {
        clearTimeout(timer);
        void renew();
      }
    };
    document.addEventListener("visibilitychange", visible);
    void renew();
    return () => {
      controller.abort();
      request?.abort();
      clearTimeout(timer);
      clearTimeout(expiryTimer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [lesson.id, attempt]);

  useEffect(() => {
    const save = () => {
      const media = player.current;
      if (media?.readyState) {
        position.current = Math.floor(media.currentTime);
        observed.current = true;
      }
      // React detaches host refs before passive unmount cleanup. Preserve the
      // last observed position so SPA navigation can still flush it.
      if (observed.current)
        onPositionRef.current(
          position.current,
          Math.floor(watched.current),
          true,
        );
    };
    if (flushPositionRef) flushPositionRef.current = save;
    const visibility = () => {
      if (document.visibilityState === "hidden") save();
    };
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      save();
      if (flushPositionRef?.current === save) flushPositionRef.current = null;
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [flushPositionRef]);

  const unavailable =
    failure instanceof LearningRequestError &&
    failure.code === "video_unavailable";
  const preparing =
    failure instanceof LearningRequestError &&
    failure.code === "video_processing";
  const denied =
    failure instanceof LearningRequestError &&
    [
      "sign_in_required",
      "access_required",
      "access_revoked",
      "course_archived",
      "forbidden",
    ].includes(failure.code);
  function savePosition(includeWatched = false) {
    const media = player.current;
    if (!media?.readyState) return;
    position.current = Math.floor(media.currentTime);
    lastSent.current = position.current;
    if (includeWatched && !seeking.current)
      watched.current = Math.max(watched.current, position.current);
    onPositionRef.current(position.current, Math.floor(watched.current));
  }
  return (
    <section aria-label="Lesson video" className="mt-8">
      {authorization ? (
        <Suspense
          fallback={
            <div
              role="status"
              className="aspect-video bg-lh-shadow p-6 text-white"
            >
              Loading the video player…
            </div>
          }
        >
          <MuxPlayer
            ref={player}
            playbackId={authorization.playbackId}
            tokens={{
              playback: authorization.playbackToken,
              thumbnail: authorization.thumbnailToken,
            }}
            className="aspect-video w-full bg-black"
            title={lesson.title}
            aria-label={`${lesson.title} video`}
            streamType="on-demand"
            playsInline
            preload="metadata"
            disableTracking
            disableCookies
            noVolumePref
            noMutedPref
            accentColor="var(--color-lh-primary)"
            storyboardSrc=""
            onLoadedMetadata={() => {
              const media = player.current;
              observed.current = true;
              if (
                media &&
                position.current > 0 &&
                Number.isFinite(media.duration)
              )
                media.currentTime = Math.min(
                  position.current,
                  Math.max(0, media.duration - 0.1),
                );
            }}
            onTimeUpdate={() => {
              const media = player.current;
              if (!media?.readyState || seeking.current) return;
              position.current = Math.floor(media.currentTime);
              if (!media.paused)
                watched.current = Math.max(watched.current, position.current);
              if (Math.abs(position.current - lastSent.current) >= 10)
                savePosition(true);
            }}
            onPause={() => savePosition()}
            onEnded={() => savePosition(true)}
            onSeeking={() => {
              seeking.current = true;
            }}
            onSeeked={() => {
              seeking.current = false;
              savePosition();
            }}
            onError={() => {
              player.current?.pause();
              setAuthorization(null);
              setFailure(new Error("Media unavailable"));
            }}
          >
            {lesson.captions.map((caption) => {
              const src = safeLearningUrl(caption.url);
              return src ? (
                <track
                  key={`${caption.language}-${src}`}
                  kind="captions"
                  src={src}
                  srcLang={caption.language}
                  label={caption.label}
                />
              ) : null;
            })}
          </MuxPlayer>
        </Suspense>
      ) : failure ? (
        <div
          role={denied ? "alert" : "status"}
          className="border border-lh-primary/20 bg-lh-primary/5 p-6"
        >
          <p>
            {preparing
              ? "This video is still processing. The lesson text and transcript are available below."
              : unavailable
                ? "A video is not available for this lesson. You can read the lesson and transcript below."
                : learningErrorText(failure)}
          </p>
          {!denied ? (
            <button
              type="button"
              className={`${learningSecondaryAction} mt-4`}
              onClick={() => {
                setFailure(null);
                setAttempt((value) => value + 1);
              }}
            >
              Retry video
            </button>
          ) : (
            <a
              href="/academy"
              className="mt-4 inline-block underline underline-offset-4"
            >
              Return to my academy
            </a>
          )}
        </div>
      ) : (
        <div role="status" className="aspect-video bg-lh-shadow p-6 text-white">
          Authorizing video…
        </div>
      )}
      <p className="mt-3 text-sm text-lh-muted">
        Use the player’s captions control to select an available language.
        Keyboard controls are available when the player has focus.
      </p>
    </section>
  );
}
