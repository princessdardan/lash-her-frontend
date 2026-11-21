-- Run in the restore transaction before starting the API or media worker.
-- The operator supplies authoritative deletion IDs in the session-local
-- pg_temp.community_media_deleted_assets(id uuid PRIMARY KEY) table. An
-- older database backup is not a source for this table.
UPDATE public.community_discussion_media AS media
SET status = 'removed', checksum = '[Deleted]', etag = NULL, width = NULL,
    height = NULL, derivative_bytes = NULL, lease_id = NULL, lease_until = NULL,
    cleanup_at = LEAST(media.cleanup_at, CURRENT_TIMESTAMP)
FROM pg_temp.community_media_deleted_assets AS deleted
WHERE media.id = deleted.id
  AND (
    media.status <> 'removed' OR media.checksum <> '[Deleted]' OR media.etag IS NOT NULL
    OR media.width IS NOT NULL OR media.height IS NOT NULL OR media.derivative_bytes IS NOT NULL
    OR media.lease_id IS NOT NULL OR media.lease_until IS NOT NULL
  );
