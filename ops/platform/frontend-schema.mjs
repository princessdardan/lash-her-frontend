// Compare structural definitions and validity, never relation OIDs or row values.
// Baselines are reviewed private release inputs bound to the exact SQL artifact.
const catalogQueries = {
  relations: `SELECT c.relname, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity,
    CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid, true) END AS view_definition
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`,
  columns: `SELECT c.relname, a.attnum, a.attname, format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull, a.attidentity, a.attgenerated, col.collname,
    pg_get_expr(d.adbin,d.adrelid) AS default_expression
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    LEFT JOIN pg_collation col ON col.oid=a.attcollation
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum`,
  constraints: `SELECT c.relname, k.conname, k.contype, k.convalidated, k.condeferrable, k.condeferred,
    to_jsonb(k)->'conenforced' AS enforced,
    pg_get_constraintdef(k.oid,true) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    WHERE c.relnamespace='public'::regnamespace ORDER BY c.relname,k.conname`,
  indexes: `SELECT c.relname AS table_name, i.relname AS index_name, x.indisunique, x.indisprimary,
    x.indisvalid,x.indisready,x.indislive,pg_get_indexdef(x.indexrelid) AS definition
    FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
    WHERE c.relnamespace='public'::regnamespace ORDER BY c.relname,i.relname`,
  triggers: `SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
  functions: `SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN ('f','p') ORDER BY p.proname,arguments`,
  enums: `SELECT t.typname,e.enumsortorder,e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
    WHERE t.typnamespace='public'::regnamespace ORDER BY t.typname,e.enumsortorder`,
  sequences: `SELECT c.relname,format_type(s.seqtypid,NULL) AS type,s.seqstart::text,s.seqincrement::text,
    s.seqmax::text,s.seqmin::text,s.seqcache::text,s.seqcycle FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid
    WHERE c.relnamespace='public'::regnamespace ORDER BY c.relname`,
  policies: `SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname`,
};
export async function readMigrationCatalog(connection) {
  const result = {};
  for (const [kind, sql] of Object.entries(catalogQueries))
    result[kind] = (await connection.query(sql)).rows;
  return result;
}
