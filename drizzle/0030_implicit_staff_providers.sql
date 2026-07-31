-- Preserve an existing provider assignment when it unambiguously matches a
-- staff account by display name.
WITH candidates AS (
  SELECT
    admin_user.id AS admin_user_id,
    provider.primary_resource_id AS booking_resource_id,
    count(*) OVER (PARTITION BY admin_user.id) AS providers_for_user,
    count(*) OVER (PARTITION BY provider.id) AS users_for_provider
  FROM "admin_users" AS admin_user
  CROSS JOIN "booking_providers" AS provider
  WHERE lower(trim(coalesce(admin_user.display_name, ''))) =
        lower(trim(provider.display_name))
    AND trim(coalesce(admin_user.display_name, '')) <> ''
    AND NOT EXISTS (
      SELECT 1
      FROM "admin_user_resources" AS existing_user_provider
      INNER JOIN "booking_resources" AS existing_resource
        ON existing_resource.id = existing_user_provider.booking_resource_id
      WHERE existing_user_provider.admin_user_id = admin_user.id
        AND existing_resource.kind = 'provider'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "admin_user_resources" AS claimed_provider
      WHERE claimed_provider.booking_resource_id = provider.primary_resource_id
    )
)
INSERT INTO "admin_user_resources" (
  "admin_user_id",
  "booking_resource_id",
  "created_by_admin_user_id"
)
SELECT admin_user_id, booking_resource_id, admin_user_id
FROM candidates
WHERE providers_for_user = 1 AND users_for_provider = 1
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Handle the common legacy installation with one owner and one provider even
-- when their display names differ.
WITH unmatched_users AS (
  SELECT admin_user.id
  FROM "admin_users" AS admin_user
  WHERE NOT EXISTS (
    SELECT 1
    FROM "admin_user_resources" AS assignment
    INNER JOIN "booking_resources" AS resource
      ON resource.id = assignment.booking_resource_id
    WHERE assignment.admin_user_id = admin_user.id
      AND resource.kind = 'provider'
  )
),
unclaimed_providers AS (
  SELECT provider.primary_resource_id
  FROM "booking_providers" AS provider
  WHERE NOT EXISTS (
    SELECT 1
    FROM "admin_user_resources" AS assignment
    WHERE assignment.booking_resource_id = provider.primary_resource_id
  )
)
INSERT INTO "admin_user_resources" (
  "admin_user_id",
  "booking_resource_id",
  "created_by_admin_user_id"
)
SELECT unmatched_users.id, unclaimed_providers.primary_resource_id, unmatched_users.id
FROM unmatched_users
CROSS JOIN unclaimed_providers
WHERE (SELECT count(*) FROM unmatched_users) = 1
  AND (SELECT count(*) FROM unclaimed_providers) = 1
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Provision a draft provider profile for every remaining staff account. The
-- scheduler retains its internal provider/resource IDs, but they are now
-- implementation details derived from the account.
DO $$
DECLARE
  staff RECORD;
  resource_id uuid;
  staff_name text;
  staff_key text;
  slug_base text;
  business_timezone text;
BEGIN
  SELECT coalesce(
    (SELECT timezone FROM "booking_business_settings" WHERE singleton_key = 'default'),
    'America/Toronto'
  ) INTO business_timezone;

  FOR staff IN
    SELECT admin_user.id, admin_user.display_name, admin_user.email
    FROM "admin_users" AS admin_user
    WHERE NOT EXISTS (
      SELECT 1
      FROM "admin_user_resources" AS assignment
      INNER JOIN "booking_resources" AS resource
        ON resource.id = assignment.booking_resource_id
      WHERE assignment.admin_user_id = admin_user.id
        AND resource.kind = 'provider'
    )
    ORDER BY admin_user.created_at, admin_user.id
  LOOP
    resource_id := gen_random_uuid();
    staff_name := coalesce(
      nullif(trim(staff.display_name), ''),
      nullif(split_part(staff.email, '@', 1), ''),
      'Team member'
    );
    staff_key := 'staff-' || replace(lower(staff.id::text), '-', '');
    slug_base := trim(both '-' from regexp_replace(
      lower(staff_name),
      '[^a-z0-9]+',
      '-',
      'g'
    ));
    slug_base := coalesce(nullif(left(slug_base, 48), ''), 'team-member');

    INSERT INTO "booking_resources" (
      "id",
      "resource_key",
      "name",
      "kind",
      "timezone",
      "status",
      "created_by_admin_user_id",
      "updated_by_admin_user_id"
    ) VALUES (
      resource_id,
      staff_key,
      staff_name,
      'provider',
      business_timezone,
      'draft',
      staff.id,
      staff.id
    );

    INSERT INTO "booking_providers" (
      "provider_key",
      "display_name",
      "primary_resource_id",
      "public_slug",
      "status",
      "created_by_admin_user_id",
      "updated_by_admin_user_id"
    ) VALUES (
      staff_key,
      staff_name,
      resource_id,
      slug_base || '-' || left(replace(lower(staff.id::text), '-', ''), 8),
      'draft',
      staff.id,
      staff.id
    );

    INSERT INTO "admin_user_resources" (
      "admin_user_id",
      "booking_resource_id",
      "created_by_admin_user_id"
    ) VALUES (staff.id, resource_id, staff.id);
  END LOOP;
END $$;
