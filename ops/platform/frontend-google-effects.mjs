// Actual SQL credential/event bindings. Secrets remain in this private worker
// payload only; the retained snapshot contains metadata and opaque IDs/digests.
import { createDecipheriv, createHash } from "node:crypto";
const demand = ok => { if (!ok) throw new Error("FRONTEND_GOOGLE_DATABASE_BINDING_REFUSED"); };
const sha = value => createHash("sha256").update(value).digest("hex");
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
export const frontendGoogleSnapshotSha256 = value => sha(JSON.stringify(ordered(value)));
export function normalizeFrontendGoogleSnapshot(input) {
  demand(input && ["connections", "assignments", "events"].every(key => Array.isArray(input[key]) && input[key].length <= 4096));
  const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
  const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  const connections = input.connections.map(row => {
    demand(uuid(row.connectionId) && ["active", "reconnect_required", "revoked", "disabled"].includes(row.status) && typeof row.credentialPresent === "boolean" &&
      (row.ownerSha256 === null || digest(row.ownerSha256)));
    return { connectionId: row.connectionId, status: row.status, credentialPresent: row.credentialPresent, ownerSha256: row.ownerSha256 };
  }).sort((a, b) => a.connectionId.localeCompare(b.connectionId));
  const assignments = input.assignments.map(row => {
    demand(uuid(row.assignmentId) && uuid(row.connectionId) && digest(row.calendarSha256) && ["active", "disabled"].includes(row.status));
    return { assignmentId: row.assignmentId, connectionId: row.connectionId, calendarSha256: row.calendarSha256, status: row.status };
  }).sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));
  const events = input.events.map(row => {
    demand(["appointment-calendar-event", "appointment-hold", "checkout-order"].includes(row.recordKind) && uuid(row.recordId) && digest(row.calendarSha256) &&
      (row.eventId === null || typeof row.eventId === "string" && /^[A-Za-z0-9_-]{1,1024}$/u.test(row.eventId)) &&
      (row.etag === null || typeof row.etag === "string" && /^[ -~]{1,1024}$/u.test(row.etag)) &&
      typeof row.status === "string" && /^[a-z_]{1,64}$/u.test(row.status));
    const result = Object.fromEntries(["recordKind", "recordId", "calendarSha256", "eventId", "etag", "status"].map(key => [key, row[key]]));
    if (row.recordKind === "appointment-calendar-event") {
      demand((row.originHoldId === null || uuid(row.originHoldId)) && (row.checkoutOrderId === null || uuid(row.checkoutOrderId)));
      result.originHoldId = row.originHoldId; result.checkoutOrderId = row.checkoutOrderId;
    }
    return result;
  }).sort((a, b) => `${a.recordKind}/${a.recordId}`.localeCompare(`${b.recordKind}/${b.recordId}`));
  for (const [rows, key] of [[connections, "connectionId"], [assignments, "assignmentId"], [events, null]])
    demand(new Set(rows.map(row => key ? row[key] : `${row.recordKind}/${row.recordId}`)).size === rows.length);
  return { connections, assignments, events };
}

function decrypt(value, key) {
  demand(typeof key === "string" && Buffer.from(key, "base64").length === 32 && Buffer.from(key, "base64").toString("base64") === key && typeof value === "string");
  const [version, iv64, tag64, payload64, extra] = value.split(":");
  demand(version === "v1" && extra === undefined && [iv64, tag64, payload64].every(part => typeof part === "string" && Buffer.from(part, "base64").toString("base64") === part));
  const iv = Buffer.from(iv64, "base64"), tag = Buffer.from(tag64, "base64"); demand(iv.length === 12 && tag.length === 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  decipher.setAAD(Buffer.from("lash-her:booking-calendar-credential:v1")); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(payload64, "base64")), decipher.final()]).toString("utf8");
}

export async function observeFrontendGoogleDatabase(client, reviewed, privateRuntime, verifySession, requireInitialSnapshot = true) {
  demand(client && typeof verifySession === "function" && reviewed?.projectId === "lash-her-staging-20261022");
  await verifySession();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const read = async sql => { await verifySession(); const rows = (await client.query(`${sql} LIMIT 4097`)).rows; demand(rows.length <= 4096); return rows; };
    const connections = await read(`SELECT id::text,provider_account_id,status::text,credential_ciphertext,credential_secret_ref
      FROM public.booking_calendar_connections WHERE provider='google' ORDER BY id`);
    const assignments = await read(`SELECT id::text,calendar_connection_id::text,provider_calendar_id,status::text
      FROM public.booking_resource_calendar_assignments ORDER BY id`);
    const appointmentEvents = await read(`SELECT e.id::text,e.provider_calendar_id,e.provider_event_id,e.provider_event_etag,e.sync_status::text,
      e.deleted_at IS NOT NULL AS deleted,a.source_hold_id::text,a.checkout_order_id::text FROM public.appointment_calendar_events e
      JOIN public.appointments a ON a.id=e.appointment_id ORDER BY e.id`);
    const holds = await read(`SELECT id::text,google_calendar_id,google_event_id,finalization_status::text,status::text
      FROM public.appointment_holds WHERE google_event_id IS NOT NULL OR finalization_status='paid_calendar_pending' ORDER BY id`);
    const checkout = await read(`SELECT id::text,calendar_event_id,calendar_finalization_status::text FROM public.checkout_orders
      WHERE calendar_event_id IS NOT NULL OR calendar_finalization_status='paid_calendar_pending' ORDER BY id`);
    const calendars = {}, grants = [];
    const calendar = value => {
      demand(typeof value === "string" && value.length > 0 && value.length <= 1024);
      const digest = sha(value); calendars[digest] = value; return digest;
    };
    const legacyCalendar = () => {
      const digest = calendar(privateRuntime.googleLegacyCalendarId);
      demand(digest === reviewed.legacyCalendarSha256); return digest;
    };
    if (reviewed.legacyCalendarSha256 !== null) legacyCalendar();
    const safeConnections = connections.map(row => {
      const stored = row.credential_ciphertext !== null || row.credential_secret_ref !== null;
      demand(!(row.credential_ciphertext !== null && row.credential_secret_ref !== null));
      let ownerSha256 = null;
      if (stored) {
        demand(typeof row.provider_account_id === "string" && /^[0-9]{1,40}$/u.test(row.provider_account_id));
        ownerSha256 = sha(row.provider_account_id);
        const refreshToken = row.credential_ciphertext !== null ? decrypt(row.credential_ciphertext, privateRuntime.googleCalendarCredentialEncryptionKey) :
          privateRuntime.googleCalendarCredentialReferences?.[row.credential_secret_ref];
        demand(typeof refreshToken === "string" && refreshToken.length > 0 && refreshToken.length <= 8192);
        grants.push({ grantId: `connection:${row.id}`, refreshToken, ownerSha256 });
      }
      return { connectionId: row.id, status: row.status, credentialPresent: stored, ownerSha256 };
    });
    const safeAssignments = assignments.map(row => ({ assignmentId: row.id, connectionId: row.calendar_connection_id,
      calendarSha256: calendar(row.provider_calendar_id), status: row.status }));
    const events = appointmentEvents.map(row => ({ recordKind: "appointment-calendar-event", recordId: row.id,
      calendarSha256: calendar(row.provider_calendar_id), eventId: row.provider_event_id, etag: row.provider_event_etag,
      status: row.deleted ? "deleted" : row.sync_status, originHoldId: row.source_hold_id, checkoutOrderId: row.checkout_order_id }));
    for (const row of holds) events.push({ recordKind: "appointment-hold", recordId: row.id,
      calendarSha256: row.google_calendar_id === null ? legacyCalendar() : calendar(row.google_calendar_id),
      eventId: row.google_event_id, etag: null, status: row.finalization_status });
    for (const row of checkout) events.push({ recordKind: "checkout-order", recordId: row.id,
      calendarSha256: legacyCalendar(), eventId: row.calendar_event_id, etag: null, status: row.calendar_finalization_status });
    events.sort((a, b) => `${a.recordKind}/${a.recordId}`.localeCompare(`${b.recordKind}/${b.recordId}`));
    const snapshot = normalizeFrontendGoogleSnapshot({ connections: safeConnections, assignments: safeAssignments, events });
    demand((!requireInitialSnapshot || frontendGoogleSnapshotSha256(snapshot) === reviewed.databaseSnapshotSha256) &&
      Object.keys(calendars).sort().every(key => reviewed.calendars.some(row => row.calendarSha256 === key)));
    for (const grant of grants) {
      const expected = reviewed.grants.find(row => row.grantId === grant.grantId);
      demand(expected && expected.ownerSha256 === grant.ownerSha256);
    }
    await verifySession(); await client.query("COMMIT"); await verifySession();
    return { snapshot, grants, calendars, events };
  } catch {
    try { await client.query("ROLLBACK"); } catch { /* original uncertain read remains unqualified */ }
    throw new Error("FRONTEND_GOOGLE_DATABASE_BINDING_REFUSED");
  }
}
