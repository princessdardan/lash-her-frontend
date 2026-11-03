// HMACs leave the runtime container; selected business rows and the private
// per-action key do not. Newly created rows are allowed during recovery.
import { createHmac } from "node:crypto";

const demand = (value, code) => { if (!value) throw new Error(code); };
export const businessQueries = Object.freeze({
  course: {
    users: "SELECT id FROM users ORDER BY id LIMIT 2001",
    courses: "SELECT id,slug,status FROM courses ORDER BY id LIMIT 2001",
    enrollments: "SELECT id,user_id,course_id,status,source FROM enrollments ORDER BY id LIMIT 2001",
    grants: "SELECT * FROM entitlement_grants ORDER BY id LIMIT 2001",
    commands: "SELECT * FROM admin_entitlement_commands ORDER BY id LIMIT 2001",
    effects: "SELECT * FROM admin_entitlement_command_effects ORDER BY id LIMIT 2001",
    idempotency: "SELECT * FROM entitlement_idempotency_keys ORDER BY idempotency_key LIMIT 2001",
  },
  community: {
    projections: "SELECT stream_id,user_id,course_id,state,applied_version,highest_observed_version,status FROM course_enrollment_projections ORDER BY stream_id LIMIT 2001",
    inbox: "SELECT event_id,canonical_digest,status FROM course_enrollment_inbox ORDER BY event_id LIMIT 2001",
  },
});
const keyFields = { users: "id", courses: "id", enrollments: "id", grants: "id", commands: "id", effects: "id",
  idempotency: "idempotency_key", projections: "stream_id", inbox: "event_id" };
const canonical = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function businessFingerprint(service, tables, privateKey) {
  demand(businessQueries[service] && tables && typeof tables === "object"
    && Object.keys(tables).sort().join(",") === Object.keys(businessQueries[service]).sort().join(",")
    && typeof privateKey === "string" && /^[a-f0-9]{64}$/u.test(privateKey), "STAGING_FINGERPRINT_BOUND_INPUT_REQUIRED");
  const mac = value => createHmac("sha256", Buffer.from(privateKey, "hex")).update(value).digest("hex");
  const result = {};
  for (const [name, rows] of Object.entries(tables)) {
    demand(Array.isArray(rows) && rows.length <= 2000 && rows.every(row => row && typeof row[keyFields[name]] === "string"),
      "STAGING_FINGERPRINT_ROW_BOUND_REQUIRED");
    const entries = rows.map(row => ({ key: mac(`${service}/${name}/${row[keyFields[name]]}`),
      value: mac(`${service}/${name}/${JSON.stringify(canonical(row))}`) })).sort((a, b) => a.key.localeCompare(b.key));
    demand(new Set(entries.map(entry => entry.key)).size === rows.length, "STAGING_FINGERPRINT_UNIQUE_ROWS_REQUIRED");
    result[name] = { count: rows.length, rows: entries };
  }
  return { status: "STAGING_BUSINESS_FINGERPRINT_READ_ONLY", service, algorithm: "HMAC-SHA256/private-action-key",
    tables: result, rawRowsExported: false, privateKeyExported: false };
}

export function verifyBusinessPreserved(before, after) {
  demand(before?.status === "STAGING_BUSINESS_FINGERPRINT_READ_ONLY" && after?.status === before.status
    && after.service === before.service && before.algorithm === after.algorithm
    && Object.keys(before.tables).sort().join(",") === Object.keys(after.tables).sort().join(","),
  "STAGING_FINGERPRINT_SAME_SCOPE_REQUIRED");
  let preservedRows = 0;
  for (const [name, table] of Object.entries(before.tables)) {
    const current = after.tables[name];
    demand(current && table.count === table.rows.length && current.count === current.rows.length
      && new Set(current.rows.map(row => row.key)).size === current.count
      && table.rows.every(row => current.rows.some(value => value.key === row.key && value.value === row.value)),
    "STAGING_BUSINESS_ROWS_CHANGED");
    preservedRows += table.count;
  }
  return { status: "STAGING_PRIOR_BUSINESS_ROWS_PRESERVED", service: before.service, preservedRows, tables: Object.keys(before.tables).sort() };
}
