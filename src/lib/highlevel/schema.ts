import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Channel, ConsentChoice, CrmEntityType } from "./contract";
const time = (name: string) => timestamp(name, { withTimezone: true });

export const highlevelConnections = pgTable("highlevel_connections", {
  locationId: text("location_id").primaryKey(),
  credentialsCiphertext: text("credentials_ciphertext").notNull(),
  expiresAt: time("expires_at").notNull(),
  refreshState: text("refresh_state").notNull().default("ready"),
  installedBy: uuid("installed_by").notNull(),
  updatedAt: time("updated_at").notNull().defaultNow(),
});
export const highlevelOauthStates = pgTable("highlevel_oauth_states", {
  hash: text("hash").primaryKey(),
  actorId: uuid("actor_id").notNull(),
  expiresAt: time("expires_at").notNull(),
});
export const highlevelContacts = pgTable(
  "highlevel_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: text("location_id").notNull(),
    emailNormalized: text("email_normalized").notNull(),
    phone: text("phone"),
    providerId: text("provider_id"),
    deletedAt: time("deleted_at"),
    providerEmailBlocked: boolean("provider_email_blocked")
      .notNull()
      .default(false),
    providerSmsBlocked: boolean("provider_sms_blocked")
      .notNull()
      .default(false),
    providerUpdatedAt: time("provider_updated_at"),
    lastSyncedAt: time("last_synced_at"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("highlevel_contacts_email_idx").on(
      t.locationId,
      t.emailNormalized,
    ),
    uniqueIndex("highlevel_contacts_provider_idx").on(
      t.locationId,
      t.providerId,
    ),
  ],
);
export const highlevelConsentEvents = pgTable(
  "highlevel_consent_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    originKey: text("origin_key").notNull().unique(),
    emailNormalized: text("email_normalized").notNull(),
    channel: text("channel").$type<Channel>().notNull(),
    destination: text("destination").notNull(),
    choice: text("choice").$type<ConsentChoice>().notNull(),
    consentText: text("consent_text"),
    consentVersion: text("consent_version"),
    source: text("source").notNull(),
    occurredAt: time("occurred_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("highlevel_consent_identity_idx").on(
      t.emailNormalized,
      t.channel,
      t.destination,
      t.occurredAt,
    ),
  ],
);
export const highlevelOutbox = pgTable(
  "highlevel_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventKey: text("event_key").notNull().unique(),
    entityType: text("entity_type").$type<CrmEntityType>().notNull(),
    entityId: text("entity_id").notNull(),
    eventType: text("event_type").notNull(),
    version: integer("version").notNull().default(1),
    historical: boolean("historical").notNull().default(false),
    occurredAt: time("occurred_at").notNull().defaultNow(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextRunAt: time("next_run_at").notNull().defaultNow(),
    lockedBy: text("locked_by"),
    lockedUntil: time("locked_until"),
    lastError: text("last_error"),
    completedAt: time("completed_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("highlevel_outbox_due_idx").on(t.status, t.nextRunAt),
    index("highlevel_outbox_entity_idx").on(t.entityType, t.entityId),
  ],
);
export const highlevelEffects = pgTable("highlevel_effects", {
  key: text("key").primaryKey(),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => highlevelContacts.id),
  kind: text("kind").notNull(),
  providerId: text("provider_id"),
  state: text("state").notNull().default("pending"),
  data: jsonb("data").$type<Record<string, string>>().notNull().default({}),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
});
export const highlevelWebhookReceipts = pgTable("highlevel_webhook_receipts", {
  key: text("key").primaryKey(),
  locationId: text("location_id").notNull(),
  eventType: text("event_type").notNull(),
  providerContactId: text("provider_contact_id"),
  receivedAt: time("received_at").notNull().defaultNow(),
});
