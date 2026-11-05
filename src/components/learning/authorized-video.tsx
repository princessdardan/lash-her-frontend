"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { MuxPlayerRefAttributes } from "@mux/mux-player-react";
import type { LearnerLesson, PlaybackAuthorization } from "@/lib/learning/types";
import { learningErrorText, learningRequest, LearningRequestError } from "@/lib/learning/browser-request";
import { safeLearningUrl } from "@/lib/learning/presentation";
import { learningSecondaryAction } from "./shared";

const MuxPlayer = lazy(() => import("@mux/mux-player-react"));
type Media = MuxPlayerRefAttributes;

export function AuthorizedVideo({ lesson, resume, onPosition }: { lesson: LearnerLesson; resume: number; onPosition: (resume: number, watched?: number, keepalive?: boolean) => void }) {
  const [authorization, setAuthorization] = useState<PlaybackAuthorization | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const player = useRef<Media | null>(null);
  const position = useRef(resume);
  const lastSent = useRef(resume);
  const watched = useRef(0);
  const seeking = useRef(false);
  const onPositionRef = useRef(onPosition);
  useEffect(() => { onPositionRef.current = onPosition; }, [onPosition]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let expires = 0;
    const renew = async () => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try {
        const result = await learningRequest<PlaybackAuthorization>(`/api/academy/lessons/${lesson.id}/playback`, { signal: controller.signal });
        if (!result.playbackToken || !result.thumbnailToken || !result.thumbnailExpiresAt || Date.parse(result.expiresAt) <= Date.now() || Date.parse(result.thumbnailExpiresAt) <= Date.now()) throw new Error("Incomplete playback authorization");
        if (controller.signal.aborted) return;
        expires = Math.min(Date.parse(result.expiresAt), Date.parse(result.thumbnailExpiresAt));
        setAuthorization(result); setFailure(null);
        timer = setTimeout(() => { void renew(); }, Math.max(1000, expires - Date.now() - 30_000));
      } catch (error) {
        if (!controller.signal.aborted) { player.current?.pause(); setAuthorization(null); setFailure(error); }
      } finally { busy = false; }
    };
    const visible = () => { if (document.visibilityState === "visible" && expires < Date.now() + 30_000) { clearTimeout(timer); void renew(); } };
    document.addEventListener("visibilitychange", visible);
    void renew();
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [lesson.id, attempt]);

  useEffect(() => {
    const save = () => { const media = player.current; if (media?.readyState) onPositionRef.current(Math.floor(media.currentTime), Math.floor(watched.current), true); };
    const visibility = () => { if (document.visibilityState === "hidden") save(); };
    window.addEventListener("pagehide", save); document.addEventListener("visibilitychange", visibility);
    return () => { save(); window.removeEventListener("pagehide", save); document.removeEventListener("visibilitychange", visibility); };
  }, []);

  const unavailable = failure instanceof LearningRequestError && failure.code === "video_unavailable";
  const preparing = failure instanceof LearningRequestError && failure.code === "video_processing";
  const denied = failure instanceof LearningRequestError && ["sign_in_required", "access_required", "access_revoked", "course_archived", "forbidden"].includes(failure.code);
  function savePosition(includeWatched = false) {
    const media = player.current;
    if (!media?.readyState) return;
    position.current = Math.floor(media.currentTime);
    lastSent.current = position.current;
    if (includeWatched && !seeking.current) watched.current = Math.max(watched.current, position.current);
    onPositionRef.current(position.current, Math.floor(watched.current));
  }
  return <section aria-label="Lesson video" className="mt-8">
    {authorization ? <Suspense fallback={<div role="status" className="aspect-video bg-lh-shadow p-6 text-white">Loading the video player…</div>}>
      <MuxPlayer ref={player} playbackId={authorization.playbackId} tokens={{ playback: authorization.playbackToken, thumbnail: authorization.thumbnailToken }}
        className="aspect-video w-full bg-black" title={lesson.title} aria-label={`${lesson.title} video`} streamType="on-demand" playsInline preload="metadata"
        disableTracking disableCookies noVolumePref noMutedPref accentColor="var(--color-lh-primary)" storyboardSrc=""
        onLoadedMetadata={() => { const media = player.current; if (media && position.current > 0 && Number.isFinite(media.duration)) media.currentTime = Math.min(position.current, Math.max(0, media.duration - 0.1)); }}
        onTimeUpdate={() => { const media = player.current; if (!media?.readyState || seeking.current) return;
          position.current = Math.floor(media.currentTime); if (!media.paused) watched.current = Math.max(watched.current, position.current);
          if (Math.abs(position.current - lastSent.current) >= 10) savePosition(true);
        }}
        onPause={() => savePosition()} onEnded={() => savePosition(true)} onSeeking={() => { seeking.current = true; }}
        onSeeked={() => { seeking.current = false; savePosition(); }}
        onError={() => { player.current?.pause(); setAuthorization(null); setFailure(new Error("Media unavailable")); }}>
        {lesson.captions.map(caption => { const src = safeLearningUrl(caption.url); return src ? <track key={`${caption.language}-${src}`} kind="captions" src={src} srcLang={caption.language} label={caption.label} /> : null; })}
      </MuxPlayer>
    </Suspense> : failure ? <div role={denied ? "alert" : "status"} className="border border-lh-primary/20 bg-lh-primary/5 p-6">
      <p>{preparing ? "This video is still processing. The lesson text and transcript are available below." : unavailable ? "A video is not available for this lesson. You can read the lesson and transcript below." : learningErrorText(failure)}</p>
      {!denied ? <button type="button" className={`${learningSecondaryAction} mt-4`} onClick={() => { setFailure(null); setAttempt(value => value + 1); }}>Retry video</button> : <a href="/academy" className="mt-4 inline-block underline underline-offset-4">Return to my academy</a>}
    </div> : <div role="status" className="aspect-video bg-lh-shadow p-6 text-white">Authorizing video…</div>}
    <p className="mt-3 text-sm text-lh-muted">Use the player’s captions control to select an available language. Keyboard controls are available when the player has focus.</p>
  </section>;
}
