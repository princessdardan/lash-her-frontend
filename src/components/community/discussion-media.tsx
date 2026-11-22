"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { paths } from "@/lib/api-integration/generated/community-discussions";
import { communityFetch, CommunityRequestError } from "@/lib/community/client";
import { useCommunityResource } from "./use-community-resource";

type List =
  paths["/v1/discussions/{postId}/media"]["get"]["responses"][200]["content"]["application/json"];
type Upload =
  paths["/v1/discussions/{postId}/media"]["post"]["responses"][201]["content"]["application/json"];
type View =
  paths["/v1/media/{mediaId}/view"]["get"]["responses"][200]["content"]["application/json"];
const limit = 10 * 1024 * 1024;
const mediaPath = (base: string, id: string) => `${base}/media/${id}`;

function storageUrl(value: string) {
  const url = new URL(value);
  const local =
    url.origin === "http://127.0.0.1:4110" && location.hostname === "127.0.0.1";
  if (
    (!local && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("The image storage link is invalid.");
  return url.href;
}

function ProcessedImage({ image, apiBase }: { image: List["images"][number]; apiBase: string }) {
  const { data, error, refresh } = useCommunityResource<View>(
    mediaPath(apiBase, image.id) + "/view",
  );
  const [failedUrl, setFailedUrl] = useState("");
  if (error) return <p role="status">{error.message}</p>;
  if (!data) return <p role="status">Loading image…</p>;
  let url: string;
  try {
    url = storageUrl(data.url);
  } catch {
    return <p role="status">This image is unavailable.</p>;
  }
  if (failedUrl === url)
    return (
      <Button type="button" variant="outline" size="sm" onClick={refresh}>
        Reload image
      </Button>
    );
  return (
    // The browser must use the private, signed URL without an image optimizer or shared cache.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      width={image.width ?? undefined}
      height={image.height ?? undefined}
      alt="Discussion attachment"
      referrerPolicy="no-referrer"
      onError={() => setFailedUrl(url)}
      className="h-auto max-h-[36rem] max-w-full rounded-md object-contain"
    />
  );
}

const messages = {
  awaiting_upload: "Waiting for upload.",
  queued: "Image queued for processing.",
  processing: "Processing image.",
  rejected: "This image was rejected.",
};

export function DiscussionMedia({
  postId,
  own,
  writes,
  locked,
  apiBase = "/api/community",
}: {
  postId: string;
  own: boolean;
  writes: boolean;
  locked: boolean;
  apiBase?: string;
}) {
  const path = `${apiBase}/discussions/${postId}/media`;
  const { data, error, refresh } = useCommunityResource<List>(path, apiBase === "/api/community" ? true : 3000);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const canUpload = own && writes && !locked;
  const slotCount =
    data?.images.filter((image) => image.status !== "rejected").length ?? 0;

  async function complete(id: string) {
    await communityFetch(mediaPath(apiBase, id) + "/complete", {
      method: "POST",
      body: {},
    });
  }

  async function mutate(operation: () => Promise<void>, message: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await operation();
      setNotice({ text: message });
      return true;
    } catch (error) {
      setNotice({
        text:
          error instanceof Error
            ? error.message
            : "The image could not be saved.",
        error: true,
      });
      return false;
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const files = new FormData(form)
      .getAll("images")
      .filter((file): file is File => file instanceof File && file.size > 0);
    if (
      !files.length ||
      files.length + slotCount > 5 ||
      files.some(
        (file) =>
          file.size > limit ||
          !["image/jpeg", "image/png", "image/webp"].includes(file.type),
      )
    ) {
      setNotice({
        text: "Choose up to five JPEG, PNG, or WebP images, each no larger than 10 MB.",
        error: true,
      });
      return;
    }
    const saved = await mutate(async () => {
      for (const file of files) {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          await file.arrayBuffer(),
        );
        const checksum = btoa(String.fromCharCode(...new Uint8Array(digest)));
        const ticket = await communityFetch<Upload>(path, {
          method: "POST",
          body: {
            id: crypto.randomUUID(),
            type: file.type,
            bytes: file.size,
            checksum,
          },
        });
        const response = await fetch(storageUrl(ticket.url), {
          method: "PUT",
          headers: ticket.headers,
          body: file,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok)
          throw new CommunityRequestError(
            response.status,
            "upload_failed",
            "The image upload did not finish.",
          );
        await complete(ticket.id);
      }
    }, "Images submitted for processing.");
    if (saved) form.reset();
  }

  if (error)
    return error.status === 404 ? null : <p role="status">{error.message}</p>;
  if (!data || (!canUpload && !data.images.length)) return null;
  return (
    <section aria-label="Discussion images" className="space-y-3">
      <h2 className="font-heading text-xl">Images</h2>
      {notice && <p role={notice.error ? "alert" : "status"}>{notice.text}</p>}
      {data.images.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2">
          {data.images.map((image) => (
            <li key={image.id} className="space-y-2">
              {image.status === "ready" ? (
                <ProcessedImage image={image} apiBase={apiBase} />
              ) : (
                <p role="status">{messages[image.status]}</p>
              )}
              {canUpload && image.status === "awaiting_upload" && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      () => complete(image.id),
                      "Image submitted for processing.",
                    )
                  }
                >
                  Finish upload
                </Button>
              )}
              {own && writes && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void mutate(async () => {
                      await communityFetch(mediaPath(apiBase, image.id), {
                        method: "DELETE",
                        body: {},
                      });
                    }, "Image removed.")
                  }
                >
                  Remove image
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canUpload && slotCount < 5 && (
        <form className="space-y-2" onSubmit={upload}>
          <label className="block space-y-1">
            <span className="block">Add images</span>
            <input
              name="images"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              required
              disabled={busy}
              aria-describedby="discussion-image-limits"
            />
          </label>
          <p id="discussion-image-limits" className="text-sm">
            Up to five JPEG, PNG, or WebP images per discussion. 10 MB per
            image.
          </p>
          <Button type="submit" size="sm" disabled={busy}>
            Upload images
          </Button>
        </form>
      )}
      {own &&
        data.images.some(
          (image) => image.status === "queued" || image.status === "processing",
        ) && (
          <Button type="button" size="sm" variant="outline" onClick={refresh}>
            Check images
          </Button>
        )}
    </section>
  );
}
