# Course videos with Mux

Course modules use Sanity's Mux Input plugin (`sanity-plugin-mux-input` 3.x, compatible with this project's Sanity 4 / React 18). The lockfile resolves version 3.0.5, whose package metadata points to `sanity-io/plugins` under `plugins/sanity-plugin-mux-input`. The npm package name stayed the same when the repository moved. Editors upload or select videos in **Video (Mux)**. Mux stores and transcodes the media; Sanity stores `mux.videoAsset` metadata and references. The course player uses `@mux/mux-player-react` for adaptive HLS playback, with saved position, captions, poster images, and retry controls.

## Credentials: where to configure them

Adding `MUX_TOKEN_ID` and `MUX_TOKEN_SECRET` to `.env.local` alone **does not configure this plugin**. Those names may be kept locally for your own tooling, but this implementation does not read them.

1. In the Mux dashboard, select the intended Mux environment. Use an access token with **Mux Video: Read and Write** and **Mux Data: Read** permissions.
2. Open the matching website's `/studio`, select the **Videos** tool, then **Configure plugin**. The first-use video field also offers **Configure API**.
3. Enter your **Access Token ID** and **Secret Key**, then save. Keep **Enable signed URLs** disabled. Select **Public** playback when uploading or importing videos; signed-only and DRM-only assets cannot be published in a course.
4. Repeat for each Sanity dataset: `staging-2026-05-10` and `production`. Configuration belongs to the dataset, not the browser or deployment. Local Studio and preview Studio using the same dataset share it. Prefer separate Mux environments/tokens for staging and production.

The plugin stores credentials in the protected, non-root document `secrets.mux` of type `mux.apiKey`; anonymous public dataset queries cannot read it. Authorized Studio users can access this configuration. Never copy the credentials to course documents, client code, `NEXT_PUBLIC_*`, or `SANITY_STUDIO_*` variables. Rotate the plugin's saved credentials when rotating the Mux access token. Treat authenticated dataset exports containing secrets accordingly.

**Vercel:** no Mux API credentials, signing keys, or Mux webhook secret are required for this public-playback implementation. Studio uses Sanity's Mux integration for uploads and asset management. The site only receives public playback IDs. Local `.env` values are not copied into Studio automatically, and adding them to Vercel does not configure the plugin either.

**Mux webhooks:** leave the Mux dashboard webhook unconfigured for this integration. The plugin polls processing assets through Sanity's Mux API and updates their Sanity documents; keep Studio open until processing finishes. `/api/revalidate` accepts signed **Sanity** webhooks, not Mux event payloads. Changes made directly in the Mux dashboard are not automatically mirrored by an application webhook.

This preserves the existing marketing signup gate: direct public video URLs remain accessible. It does not implement private/signed playback or DRM. Mux Data tracking and cookies are disabled in the course player to preserve the site's analytics consent behavior.

## Deployment and cache updates

1. Deploy the updated application (including embedded Studio) and source schema to the intended environment. Staging schema command: `NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10 npx sanity schema deploy`. Follow the repository's production schema procedure when promoting.
2. Configure the plugin credentials as above in that dataset.
3. In the existing Sanity webhook targeting `/api/revalidate`, include **create, update, and delete** events for both `shortCourse` and `mux.videoAsset`. Add these types to the current filter without removing its other types. Keep the projection's `_type` and `_id` fields and the existing `SANITY_WEBHOOK_SECRET`.
4. Mux assets update separately from courses while processing or changing captions/posters. Their events now invalidate the same `shortCourse` cache tag. No additional Mux-to-Next.js webhook endpoint is needed.
5. Upload a test video, wait for **ready**, publish the course, then verify playback, seeking/resume, captions, and mobile layout on the actual environment. Also verify the Sanity webhook after asset updates and deletion.

## Migrating existing Sanity-hosted videos

The existing `video` field is retained as **Legacy video (Sanity)**, visible only when populated and read-only. Published lessons without a Mux reference keep playing the existing file during migration. New and edited courses require a ready Mux video before publishing.

For each existing module:

1. Keep the existing module; do not recreate it. Its `_key` preserves quiz progress.
2. In **Video (Mux)**, upload the original source file or use the URL upload option with the existing Sanity file's public download URL. This creates a Mux asset; simply changing the old field's type would not transfer the video.
3. Keep playback **Public**, wait for processing to finish, and preview it in Studio. You can also select a video already available through the plugin's library/import controls.
4. Keep any custom **Video poster**, **English captions (WebVTT)**, and **Transcript**. Without a custom poster, the player uses the Mux thumbnail (including the Studio-selected thumbnail time). Captions attached to the Mux asset are also supported by its HLS stream.
5. Publish and check `/courses/<slug>`. The Mux asset takes precedence. The new asset identity resets video position; quiz completion is preserved if the quiz is unchanged.
6. Once migration has been verified, old files can be cleaned up separately after checking other references. This change does not delete originals or automatically upload existing assets.

A selected Mux asset that is still processing, deleted, or lacks a public playback ID shows an unavailable/processing message. It never silently falls back to a different legacy video. Lessons and quizzes remain usable.

## Verification

- Unit: `node --import tsx --test src/data/loaders.courses.test.ts src/sanity/schemas/documents/short-course.test.ts src/lib/courses/progress.test.ts src/app/api/revalidate/route.test.ts`.
- Mux browser fixture: `npx playwright test --config tests/courses-mux.playwright.config.ts`. Exercises HLS playback, captions, resume, module changes, retries, and unavailable assets in desktop and mobile Chromium without a database or Mux credentials. All video traffic is intercepted locally.
- Live Studio uploads, actual Mux delivery, credential permissions, and deployed webhook configuration still require the staging smoke check above.

References: [Sanity Mux Input plugin](https://github.com/sanity-io/plugins/tree/main/plugins/sanity-plugin-mux-input), [Mux's Sanity integration guide](https://www.mux.com/docs/integrations/sanity).
