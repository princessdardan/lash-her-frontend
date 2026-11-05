"use client";
import { useEffect, useState, type FormEvent } from "react";
import { authoringRequest } from "@/lib/course-authoring/browser";
import { textField } from "@/lib/course-authoring/forms";
import type { CandidateSuccess } from "@/lib/api-integration/candidate-validation";
import { buttonClass, fieldClass, secondaryClass } from "./course-fields";
type Asset = NonNullable<
  CandidateSuccess<
    "course",
    "/v1/admin/lessons/{lessonId}/video",
    "get"
  >["current"]
>;
interface Status {
  courseRevision: number;
  current: Asset | null;
  latest: Asset | null;
}
type Upload = CandidateSuccess<
  "course",
  "/v1/admin/lessons/{lessonId}/video-upload",
  "post"
>;
export function MediaEditor({
  lessonId,
  revision,
  editable,
  onBusy,
  onChanged,
}: {
  lessonId: string;
  revision: number;
  editable: boolean;
  onBusy: (value: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const [status, setStatus] = useState<Status | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const path = `/api/admin/lessons/${lessonId}`;
  async function load() {
    setStatus(await authoringRequest<Status>(`${path}/video`));
  }
  useEffect(() => {
    let disposed = false;
    authoringRequest<Status>(`/api/admin/lessons/${lessonId}/video`)
      .then((value) => {
        if (!disposed) setStatus(value);
      })
      .catch(() => {
        if (!disposed)
          setMessage(
            "Video status could not be loaded. Reload before uploading or replacing media.",
          );
      });
    return () => {
      disposed = true;
    };
  }, [lessonId]);
  async function operation(work: () => Promise<void>, authorMutation = false) {
    if (busy) return;
    setBusy(true);
    onBusy(true);
    setMessage(null);
    try {
      await work();
      await load();
    } catch (error) {
      setMessage(
        `${error instanceof Error ? error.message : "The media operation could not be confirmed."} Refresh status before starting another upload or caption request.`,
      );
    } finally {
      if (authorMutation)
        await onChanged().catch(() => {
          setMessage(
            "The course changed, but its latest revision could not be loaded. Reload this page.",
          );
        });
      setBusy(false);
      onBusy(false);
    }
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get("video");
    if (!(file instanceof File) || file.size === 0) {
      setMessage("Choose a video file.");
      return;
    }
    await operation(async () => {
      const result = await authoringRequest<Upload>(
        `${path}/video-upload`,
        "POST",
        {
          expectedCourseRevision: revision,
          expectedCurrentVideoAssetId: status?.current?.id ?? null,
        },
      );
      const url = new URL(result.upload.url);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("The upload address could not be verified.");
      const response = await fetch(url, {
        method: "PUT",
        body: file,
        credentials: "omit",
        redirect: "error",
        mode: "cors",
        headers: { "content-type": file.type || "application/octet-stream" },
      });
      if (!response.ok) throw new Error("The upload was not confirmed.");
      setMessage(
        "Upload sent. Refresh status while the video is processed. The current ready video stays available until replacement is ready.",
      );
    }, true);
  }
  const current = status?.current,
    latest = status?.latest,
    target = latest ?? current;
  const unresolved =
    latest && ["pending", "uploading", "processing"].includes(latest.status);
  const stale = status !== null && status.courseRevision !== revision;
  return (
    <div className="space-y-5">
      <h2 className="font-heading text-3xl uppercase">Lesson media</h2>
      <p className="text-sm text-lh-muted">
        Upload or replace a video, then review processing and captions. An
        unconfirmed provider operation must be reconciled before retrying.
      </p>
      {!editable && (
        <p className="text-sm text-lh-muted">
          Move the course to draft to upload, replace or edit captions. Status
          refresh remains available.
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {status === null ? (
        <p role="status">Waiting for video status.</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt>Current video</dt>
          <dd>{current?.status ?? "None"}</dd>
          <dt>Latest upload</dt>
          <dd>{latest?.status ?? "None"}</dd>
          {target?.lastErrorCode && (
            <>
              <dt>Recovery state</dt>
              <dd>{target.lastErrorCode}</dd>
            </>
          )}
        </dl>
      )}
      {stale && (
        <p role="alert" className="text-sm">
          This course changed. Reload before editing media.
        </p>
      )}
      <button
        type="button"
        className={secondaryClass}
        disabled={busy}
        onClick={() => {
          void operation(async () => {
            if (target)
              await authoringRequest(
                `${path}/video/${target.id}/refresh`,
                "POST",
                {},
              );
          });
        }}
      >
        Refresh video status
      </button>
      <form onSubmit={upload} className="space-y-3">
        <fieldset
          disabled={!editable || busy || !status || !!unresolved || stale}
        >
          <legend className="font-semibold">
            {latest?.status === "errored"
              ? "Retry video upload"
              : current
                ? "Replace video"
                : "Upload video"}
          </legend>
          <label className="mt-3 block text-sm">
            Video file
            <input
              className={fieldClass}
              type="file"
              name="video"
              accept="video/*"
              required
            />
          </label>
        </fieldset>
        {unresolved && (
          <p className="text-sm text-lh-muted">
            An upload is pending. Refresh or allow recovery to resolve it before
            creating another.
          </p>
        )}
        <button
          className={buttonClass}
          disabled={!editable || busy || !status || !!unresolved || stale}
        >
          {busy ? "Working…" : current ? "Upload replacement" : "Upload video"}
        </button>
      </form>
      {current?.status === "ready" && (
        <section className="space-y-4">
          <h3 className="font-semibold">Captions</h3>
          <ul className="space-y-3">
            {current.captionTracks.map((track) => (
              <li
                key={track.id}
                className="flex flex-wrap items-center justify-between gap-3 text-sm"
              >
                <span>
                  {track.label} ({track.language}) · {track.status}
                </span>
                <button
                  type="button"
                  className={secondaryClass}
                  disabled={!editable || busy || stale}
                  onClick={() => {
                    void operation(async () => {
                      await authoringRequest(
                        `${path}/video/${current.id}/captions/${encodeURIComponent(track.id)}`,
                        "DELETE",
                        { expectedCourseRevision: revision },
                      );
                    }, true);
                  }}
                >
                  Remove captions
                </button>
              </li>
            ))}
          </ul>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void operation(async () => {
                await authoringRequest(
                  `${path}/video/${current.id}/captions`,
                  "POST",
                  {
                    expectedCourseRevision: revision,
                    url: textField(form, "url"),
                    language: textField(form, "language"),
                    label: textField(form, "label"),
                  },
                );
              }, true);
            }}
          >
            <fieldset
              disabled={!editable || busy || stale}
              className="space-y-3"
            >
              <legend className="text-sm font-semibold">
                Add caption track
              </legend>
              <label className="block text-sm">
                Public HTTPS caption file
                <input className={fieldClass} name="url" type="url" required />
              </label>
              <label className="block text-sm">
                Language tag
                <input
                  className={fieldClass}
                  name="language"
                  required
                  placeholder="en-CA"
                  maxLength={35}
                />
              </label>
              <label className="block text-sm">
                Caption label
                <input
                  className={fieldClass}
                  name="label"
                  required
                  maxLength={100}
                />
              </label>
            </fieldset>
            <button
              className={buttonClass}
              disabled={!editable || busy || stale}
            >
              Add captions
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
