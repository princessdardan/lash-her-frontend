BEGIN;

INSERT INTO courses (id, slug, title, introduction, seo, status, revision)
VALUES
  ('e9fc3a24-e440-5a63-badc-098caab9de56', 'free-mini-course', 'Free Mini Course',
   'Course API revision 7 introduction.',
   '{"title":"Free Mini Course SEO","description":"Course API revision 7 metadata."}',
   'published', 7),
  ('00000000-0000-4000-8000-000000000001', 'api-only-course', 'API-only Course', NULL, NULL, 'published', 1),
  ('00000000-0000-4000-8000-000000000002', 'draft-course', 'Draft Course', NULL, NULL, 'draft', 1),
  ('00000000-0000-4000-8000-000000000003', 'archived-course', 'Archived Course', NULL, NULL, 'archived', 1),
  ('00000000-0000-4000-8000-000000000004', 'unpublished-course', 'Previously Published Course', NULL, NULL, 'draft', 8),
  ('00000000-0000-4000-8000-000000000005', 'api-hidden', 'API Hidden Course', NULL, '{"noIndex":true}', 'published', 1);

-- Free Mini Course sorts onto page two of the public API catalog.
INSERT INTO courses (slug, title, seo, status, id)
SELECT 'hidden-page-fixture-' || n, 'Hidden Page Fixture', '{"noIndex":true}', 'published',
  ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
FROM generate_series(100, 199) AS n;

WITH inserted_modules AS (
  INSERT INTO modules (course_id, slug, title, position)
  VALUES
    ('e9fc3a24-e440-5a63-badc-098caab9de56', 'lash-sets', 'How to Elevate Your Lash Sets', 1),
    ('e9fc3a24-e440-5a63-badc-098caab9de56', 'content-into-clients', 'How to Convert Content Into Clients', 2),
    ('00000000-0000-4000-8000-000000000001', 'public-module', 'Public Preview Module', 1)
  RETURNING id, slug, title
)
INSERT INTO lessons (module_id, slug, title, position, is_preview, content)
SELECT id, slug, title, 1, slug = 'public-module', 'Fixture lesson body'
FROM inserted_modules;

COMMIT;
