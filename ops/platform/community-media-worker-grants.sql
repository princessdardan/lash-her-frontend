-- Apply to the reviewed Community database after the media migration and
-- creation of a dedicated, non-owner login with no inherited grants.
BEGIN;
DO $binding$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO lash_her_community_media_worker',
    current_database()
  );
END;
$binding$;
GRANT USAGE ON SCHEMA public TO lash_her_community_media_worker;
GRANT SELECT (id, status) ON public.community_content
  TO lash_her_community_media_worker;
GRANT SELECT ON public.community_discussion_media
  TO lash_her_community_media_worker;
GRANT UPDATE (
  status, lease_id, lease_until, attempts, available_at, cleanup_at,
  width, height, derivative_bytes, original_removed_at, derivative_removed_at
) ON public.community_discussion_media TO lash_her_community_media_worker;
COMMIT;
