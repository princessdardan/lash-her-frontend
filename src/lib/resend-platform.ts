import "server-only";

import type {
  AddContactSegmentOptions,
  CreateAutomationOptions,
  CreateBroadcastOptions,
  CreateContactOptions,
  CreateTemplateOptions,
  CreateTopicOptions,
  ErrorResponse,
  ListAutomationsOptions,
  ListBroadcastsOptions,
  ListContactSegmentsOptions,
  ListSegmentsOptions,
  ListTemplatesOptions,
  Response as ResendResponse,
  SendBroadcastOptions,
  SendEventOptions,
  UpdateAutomationOptions,
  UpdateBroadcastOptions,
  UpdateContactOptions,
  UpdateContactTopicsOptions,
  UpdateTemplateOptions,
} from "resend";

import {
  getEmailProfileImageTemplateVariables,
  getResendClient,
  type TransactionalEmailTemplate,
  type TransactionalEmailTemplateVariables,
} from "@/lib/transactional-email";

export type ResendContactSyncStep =
  | "update_contact"
  | "create_contact"
  | "list_segments"
  | "add_segment"
  | "update_topics"
  | "send_event";

export class ResendContactSyncError extends Error {
  readonly step: ResendContactSyncStep;
  readonly context: Record<string, unknown>;

  constructor(
    step: ResendContactSyncStep,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ResendContactSyncError";
    this.step = step;
    this.context = context;
  }
}

export type ResendEmailTemplateKey =
  | "booking_confirmation"
  | "contact_popup_admin"
  | "contact_popup_customer"
  | "general_inquiry_admin"
  | "general_inquiry_customer"
  | "product_confirmation"
  | "training_contact_admin"
  | "training_contact_customer"
  | "training_payment_admin"
  | "training_payment_customer";

export type ResendMarketingContactSource =
  | "booking"
  | "contact_popup"
  | "general_inquiry"
  | "sanity_backfill"
  | "training_contact";

export interface ResendMarketingContactInput {
  consentEventId?: string;
  consentText?: string;
  consentedAt: Date;
  contactId?: string;
  email: string;
  instagram?: string;
  name?: string;
  phone?: string;
  source: ResendMarketingContactSource;
  sourcePath?: string;
  submissionId?: string;
}

export interface ResendMarketingContactSyncPlan {
  createContact: CreateContactOptions;
  event: SendEventOptions;
  segmentAdds: AddContactSegmentOptions[];
  topicUpdate?: UpdateContactTopicsOptions;
  updateContact: UpdateContactOptions;
}

export interface ResendContactSyncDependencies {
  addContactSegment(
    input: AddContactSegmentOptions,
  ): Promise<ResendResponse<{ id: string }>>;
  createContact(
    input: CreateContactOptions,
  ): Promise<ResendResponse<{ id: string }>>;
  listContactSegments(
    input: ListContactSegmentsOptions,
  ): Promise<ResendResponse<{ data: { id: string }[] }>>;
  sendEvent(
    input: SendEventOptions,
  ): Promise<ResendResponse<{ event: string; object: "event" }>>;
  updateContact(
    input: UpdateContactOptions,
  ): Promise<ResendResponse<{ id: string }>>;
  updateContactTopics(
    input: UpdateContactTopicsOptions,
  ): Promise<ResendResponse<{ id: string }>>;
}

const TEMPLATE_ENV_BY_KEY: Record<ResendEmailTemplateKey, string> = {
  booking_confirmation: "RESEND_TEMPLATE_BOOKING_CONFIRMATION_ID",
  contact_popup_admin: "RESEND_TEMPLATE_CONTACT_POPUP_ADMIN_ID",
  contact_popup_customer: "RESEND_TEMPLATE_CONTACT_POPUP_CUSTOMER_ID",
  general_inquiry_admin: "RESEND_TEMPLATE_GENERAL_INQUIRY_ADMIN_ID",
  general_inquiry_customer: "RESEND_TEMPLATE_GENERAL_INQUIRY_CUSTOMER_ID",
  product_confirmation: "RESEND_TEMPLATE_PRODUCT_CONFIRMATION_ID",
  training_contact_admin: "RESEND_TEMPLATE_TRAINING_CONTACT_ADMIN_ID",
  training_contact_customer: "RESEND_TEMPLATE_TRAINING_CONTACT_CUSTOMER_ID",
  training_payment_admin: "RESEND_TEMPLATE_TRAINING_PAYMENT_ADMIN_ID",
  training_payment_customer: "RESEND_TEMPLATE_TRAINING_PAYMENT_CUSTOMER_ID",
};

const SOURCE_SEGMENT_ENV_BY_SOURCE: Record<
  ResendMarketingContactSource,
  string
> = {
  booking: "RESEND_SEGMENT_BOOKING_ID",
  contact_popup: "RESEND_SEGMENT_CONTACT_POPUP_ID",
  general_inquiry: "RESEND_SEGMENT_GENERAL_INQUIRY_ID",
  sanity_backfill: "RESEND_SEGMENT_SANITY_BACKFILL_ID",
  training_contact: "RESEND_SEGMENT_TRAINING_CONTACT_ID",
};

const SOURCE_TOPIC_ENV_BY_SOURCE: Partial<
  Record<ResendMarketingContactSource, string>
> = {
  contact_popup: "RESEND_TOPIC_NEWSLETTER_ID",
  training_contact: "RESEND_TOPIC_TRAINING_ID",
};

const ALL_MARKETING_SEGMENT_ENV = "RESEND_SEGMENT_MARKETING_ID";
const MARKETING_TOPIC_ENV = "RESEND_TOPIC_MARKETING_ID";
const MARKETING_CONTACT_EVENT_ENV = "RESEND_EVENT_MARKETING_CONTACT_OPTED_IN";
const DEFAULT_MARKETING_CONTACT_EVENT = "lashher.marketing_contact.opted_in";

export function getConfiguredTransactionalTemplate(
  key: ResendEmailTemplateKey,
  variables: Record<string, unknown>,
): TransactionalEmailTemplate | undefined {
  const id = getOptionalEnv(TEMPLATE_ENV_BY_KEY[key]);

  if (id === undefined) {
    return undefined;
  }

  return {
    id,
    variables: toResendTemplateVariables({
      ...variables,
      ...getEmailProfileImageTemplateVariables(),
    }),
  };
}

export function toResendTemplateVariables(
  input: Record<string, unknown>,
): TransactionalEmailTemplateVariables {
  const variables: TransactionalEmailTemplateVariables = {};

  for (const [key, value] of Object.entries(input)) {
    const normalized = toTemplateVariableValue(value);

    if (normalized !== undefined) {
      variables[key] = normalized;
    }
  }

  return variables;
}

export function buildResendMarketingContactSyncPlan(
  input: ResendMarketingContactInput,
): ResendMarketingContactSyncPlan {
  const email = input.email.trim();
  const { firstName, lastName } = splitName(input.name);
  const segmentIds = getMarketingSegmentIds(input.source);
  const topics = getMarketingTopics(input.source);
  const properties = getMarketingContactProperties(input);
  const baseContactFields = {
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    unsubscribed: false,
  };

  return {
    createContact: {
      email,
      ...baseContactFields,
      ...(segmentIds.length > 0
        ? { segments: segmentIds.map((id) => ({ id })) }
        : {}),
      ...(topics.length > 0 ? { topics } : {}),
    },
    event: {
      email,
      event:
        getOptionalEnv(MARKETING_CONTACT_EVENT_ENV) ??
        DEFAULT_MARKETING_CONTACT_EVENT,
      payload: {
        consentedAt: input.consentedAt.toISOString(),
        ...(input.contactId !== undefined
          ? { contactId: input.contactId }
          : {}),
        ...(input.submissionId !== undefined
          ? { submissionId: input.submissionId }
          : {}),
        ...(input.consentEventId !== undefined
          ? { consentEventId: input.consentEventId }
          : {}),
        source: input.source,
        sourcePath: input.sourcePath,
      },
    },
    segmentAdds: segmentIds.map((segmentId) => ({ email, segmentId })),
    ...(topics.length > 0 ? { topicUpdate: { email, topics } } : {}),
    updateContact: {
      email,
      ...baseContactFields,
    },
  };
}

export async function syncResendMarketingContact(
  input: ResendMarketingContactInput,
  dependencies?: ResendContactSyncDependencies,
): Promise<void> {
  if (getOptionalEnv("RESEND_API_KEY") === undefined) {
    return;
  }

  const resolvedDependencies =
    dependencies ?? getDefaultContactSyncDependencies();

  const plan = buildResendMarketingContactSyncPlan(input);
  const updateResult = await resolvedDependencies.updateContact(
    plan.updateContact,
  );

  if (updateResult.error !== null) {
    if (!isNotFoundError(updateResult.error)) {
      throw new ResendContactSyncError(
        "update_contact",
        `Resend contact update failed: ${updateResult.error.message}`,
        { email: input.email.trim(), source: input.source },
      );
    }

    const createResult = await resolvedDependencies.createContact(
      plan.createContact,
    );

    if (createResult.error !== null) {
      throw new ResendContactSyncError(
        "create_contact",
        `Resend contact create failed: ${createResult.error.message}`,
        { email: input.email.trim(), source: input.source },
      );
    }
  }

  if (plan.segmentAdds.length > 0) {
    const segmentResult = await resolvedDependencies.listContactSegments({
      email: input.email.trim(),
    });

    if (segmentResult.error !== null) {
      throw new ResendContactSyncError(
        "list_segments",
        `Resend contact segment list failed: ${segmentResult.error.message}`,
        { email: input.email.trim(), source: input.source },
      );
    }

    const existingSegmentIds = new Set(
      assertResendData(
        segmentResult,
        "Resend contact segment list failed",
      ).data.map((segment: { id: string }) => segment.id),
    );

    for (const segmentAdd of plan.segmentAdds) {
      if (existingSegmentIds.has(segmentAdd.segmentId)) {
        continue;
      }

      const addResult =
        await resolvedDependencies.addContactSegment(segmentAdd);

      if (
        addResult.error !== null &&
        !isAlreadySegmentMemberError(addResult.error)
      ) {
        throw new ResendContactSyncError(
          "add_segment",
          `Resend contact segment add failed: ${addResult.error.message}`,
          {
            email: input.email.trim(),
            segmentId: segmentAdd.segmentId,
            source: input.source,
          },
        );
      }
    }
  }

  if (plan.topicUpdate !== undefined) {
    const topicResult = await resolvedDependencies.updateContactTopics(
      plan.topicUpdate,
    );

    if (topicResult.error !== null) {
      throw new ResendContactSyncError(
        "update_topics",
        `Resend contact topic update failed: ${topicResult.error.message}`,
        { email: input.email.trim(), source: input.source },
      );
    }
  }

  const eventResult = await resolvedDependencies.sendEvent(plan.event);

  if (eventResult.error !== null) {
    throw new ResendContactSyncError(
      "send_event",
      `Resend marketing automation event failed: ${eventResult.error.message}`,
      {
        email: input.email.trim(),
        source: input.source,
        event: plan.event.event,
      },
    );
  }
}

export async function createResendTemplate(
  input: CreateTemplateOptions,
): Promise<{ id: string; object: "template" }> {
  return assertResendData(
    await getResendClient().templates.create(input),
    "Resend template create failed",
  );
}

export async function updateResendTemplate(
  id: string,
  input: UpdateTemplateOptions,
): Promise<{ id: string; object: "template" }> {
  return assertResendData(
    await getResendClient().templates.update(id, input),
    "Resend template update failed",
  );
}

export async function publishResendTemplate(
  id: string,
): Promise<{ id: string; object: "template" }> {
  return assertResendData(
    await getResendClient().templates.publish(id),
    "Resend template publish failed",
  );
}

export async function listResendTemplates(input?: ListTemplatesOptions) {
  return assertResendData(
    await getResendClient().templates.list(input),
    "Resend templates list failed",
  );
}

export async function getResendTemplate(id: string) {
  return assertResendData(
    await getResendClient().templates.get(id),
    "Resend template get failed",
  );
}

export async function removeResendTemplate(id: string) {
  return assertResendData(
    await getResendClient().templates.remove(id),
    "Resend template remove failed",
  );
}

export async function createResendAutomation(input: CreateAutomationOptions) {
  return assertResendData(
    await getResendClient().automations.create(input),
    "Resend automation create failed",
  );
}

export async function updateResendAutomation(
  id: string,
  input: UpdateAutomationOptions,
) {
  return assertResendData(
    await getResendClient().automations.update(id, input),
    "Resend automation update failed",
  );
}

export async function listResendAutomations(input?: ListAutomationsOptions) {
  return assertResendData(
    await getResendClient().automations.list(input),
    "Resend automations list failed",
  );
}

export async function getResendAutomation(id: string) {
  return assertResendData(
    await getResendClient().automations.get(id),
    "Resend automation get failed",
  );
}

export async function removeResendAutomation(id: string) {
  return assertResendData(
    await getResendClient().automations.remove(id),
    "Resend automation remove failed",
  );
}

export async function stopResendAutomation(id: string) {
  return assertResendData(
    await getResendClient().automations.stop(id),
    "Resend automation stop failed",
  );
}

export async function createResendBroadcast(input: CreateBroadcastOptions) {
  return assertResendData(
    await getResendClient().broadcasts.create(input),
    "Resend broadcast create failed",
  );
}

export async function updateResendBroadcast(
  id: string,
  input: UpdateBroadcastOptions,
) {
  return assertResendData(
    await getResendClient().broadcasts.update(id, input),
    "Resend broadcast update failed",
  );
}

export async function sendResendBroadcast(
  id: string,
  input?: SendBroadcastOptions,
) {
  return assertResendData(
    await getResendClient().broadcasts.send(id, input),
    "Resend broadcast send failed",
  );
}

export async function listResendBroadcasts(input?: ListBroadcastsOptions) {
  return assertResendData(
    await getResendClient().broadcasts.list(input),
    "Resend broadcasts list failed",
  );
}

export async function getResendBroadcast(id: string) {
  return assertResendData(
    await getResendClient().broadcasts.get(id),
    "Resend broadcast get failed",
  );
}

export async function removeResendBroadcast(id: string) {
  return assertResendData(
    await getResendClient().broadcasts.remove(id),
    "Resend broadcast remove failed",
  );
}

export async function createResendSegment(
  name: string,
): Promise<{ id: string }> {
  return assertResendData(
    await getResendClient().segments.create({ name }),
    "Resend segment create failed",
  );
}

export async function listResendSegments(
  input?: ListSegmentsOptions,
): Promise<{ data: Array<{ id: string }> }> {
  return assertResendData(
    await getResendClient().segments.list(input),
    "Resend segments list failed",
  );
}

export async function getResendSegment(id: string): Promise<{ id: string }> {
  return assertResendData(
    await getResendClient().segments.get(id),
    "Resend segment get failed",
  );
}

export async function removeResendSegment(id: string): Promise<{ id: string }> {
  return assertResendData(
    await getResendClient().segments.remove(id),
    "Resend segment remove failed",
  );
}

export async function createResendTopic(
  input: CreateTopicOptions,
): Promise<{ id: string }> {
  return assertResendData(
    await getResendClient().topics.create(input),
    "Resend topic create failed",
  );
}

export async function listResendTopics(): Promise<{
  data: Array<{ id: string }>;
}> {
  return assertResendData(
    await getResendClient().topics.list(),
    "Resend topics list failed",
  );
}

export async function getResendTopic(id: string): Promise<{ id: string }> {
  return assertResendData(
    await getResendClient().topics.get(id),
    "Resend topic get failed",
  );
}

export interface ResendMarketingConfigCheckDependencies {
  listSegments: (
    input?: ListSegmentsOptions,
  ) => Promise<{ data: Array<{ id: string }> }>;
  listTopics: () => Promise<{ data: Array<{ id: string }> }>;
}

export interface ResendMarketingConfigCheckResult {
  ok: boolean;
  apiKeyConfigured: boolean;
  missingSegmentIds: string[];
  missingTopicIds: string[];
}

export async function checkResendMarketingContactConfig(
  dependencies?: Partial<ResendMarketingConfigCheckDependencies>,
): Promise<ResendMarketingConfigCheckResult> {
  const apiKey = getOptionalEnv("RESEND_API_KEY");

  if (apiKey === undefined) {
    return {
      ok: false,
      apiKeyConfigured: false,
      missingSegmentIds: [],
      missingTopicIds: [],
    };
  }

  const resolvedDependencies = {
    listSegments: dependencies?.listSegments ?? listResendSegments,
    listTopics: dependencies?.listTopics ?? listResendTopics,
  };

  const configuredSegmentIds = getConfiguredMarketingSegmentIds();
  const configuredTopicIds = getConfiguredMarketingTopicIds();

  const [segmentList, topicList] = await Promise.all([
    resolvedDependencies.listSegments(),
    resolvedDependencies.listTopics(),
  ]);

  const foundSegmentIds = new Set(
    segmentList.data.map((segment) => segment.id),
  );
  const foundTopicIds = new Set(topicList.data.map((topic) => topic.id));

  const missingSegmentIds = configuredSegmentIds.filter(
    (id) => !foundSegmentIds.has(id),
  );
  const missingTopicIds = configuredTopicIds.filter(
    (id) => !foundTopicIds.has(id),
  );

  return {
    ok: missingSegmentIds.length === 0 && missingTopicIds.length === 0,
    apiKeyConfigured: true,
    missingSegmentIds,
    missingTopicIds,
  };
}

function getConfiguredMarketingSegmentIds(): string[] {
  return uniqueDefinedValues([
    getOptionalEnv(ALL_MARKETING_SEGMENT_ENV),
    ...Object.values(SOURCE_SEGMENT_ENV_BY_SOURCE).map((env) =>
      getOptionalEnv(env),
    ),
  ]);
}

function getConfiguredMarketingTopicIds(): string[] {
  return uniqueDefinedValues(
    [
      getOptionalEnv(MARKETING_TOPIC_ENV),
      ...Object.values(SOURCE_TOPIC_ENV_BY_SOURCE).map((env) =>
        getOptionalEnv(env),
      ),
    ].filter((value): value is string | undefined => value !== ""),
  );
}

function getDefaultContactSyncDependencies(): ResendContactSyncDependencies {
  const resend = getResendClient();

  return {
    addContactSegment: (input) => resend.contacts.segments.add(input),
    createContact: (input) => resend.contacts.create(input),
    listContactSegments: (input) => resend.contacts.segments.list(input),
    sendEvent: (input) => resend.events.send(input),
    updateContact: (input) => resend.contacts.update(input),
    updateContactTopics: (input) => resend.contacts.topics.update(input),
  };
}

function getMarketingSegmentIds(
  source: ResendMarketingContactSource,
): string[] {
  return uniqueDefinedValues([
    getOptionalEnv(ALL_MARKETING_SEGMENT_ENV),
    getOptionalEnv(SOURCE_SEGMENT_ENV_BY_SOURCE[source]),
  ]);
}

function getMarketingTopics(
  source: ResendMarketingContactSource,
): { id: string; subscription: "opt_in" }[] {
  return uniqueDefinedValues([
    getOptionalEnv(MARKETING_TOPIC_ENV),
    getOptionalEnv(SOURCE_TOPIC_ENV_BY_SOURCE[source] ?? ""),
  ]).map((id) => ({ id, subscription: "opt_in" }));
}

function getMarketingContactProperties(
  input: ResendMarketingContactInput,
): Record<string, string | number | null> {
  return cleanContactProperties({
    consent_text: input.consentText,
    consented_at: input.consentedAt.toISOString(),
    instagram: input.instagram,
    phone: input.phone,
    source: input.source,
    source_path: input.sourcePath,
  });
}

function cleanContactProperties(
  input: Record<string, string | number | undefined>,
): Record<string, string | number | null> {
  return Object.fromEntries(
    Object.entries(input)
      .map(
        ([key, value]) =>
          [key, typeof value === "string" ? value.trim() : value] as const,
      )
      .filter(
        (entry): entry is readonly [string, string | number] =>
          entry[1] !== undefined && entry[1] !== "",
      ),
  );
}

function splitName(name: string | undefined): {
  firstName?: string;
  lastName?: string;
} {
  const normalized = name?.trim();

  if (!normalized) {
    return {};
  }

  const [firstName, ...lastNameParts] = normalized.split(/\s+/);
  const lastName = lastNameParts.join(" ");

  return {
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
  };
}

function toTemplateVariableValue(value: unknown): string | number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return JSON.stringify(value);
}

function uniqueDefinedValues(values: (string | undefined)[]): string[] {
  return Array.from(
    new Set(
      values.filter(
        (value): value is string => value !== undefined && value.length > 0,
      ),
    ),
  );
}

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();

  return value ? value : undefined;
}

function assertResendData<T>(response: ResendResponse<T>, message: string): T {
  if (response.error !== null) {
    throw new Error(`${message}: ${response.error.message}`);
  }

  return response.data;
}

function isNotFoundError(error: ErrorResponse): boolean {
  return error.name === "not_found" || error.statusCode === 404;
}

function isAlreadySegmentMemberError(error: ErrorResponse): boolean {
  return (
    error.name === "validation_error" &&
    error.message.toLowerCase().includes("already")
  );
}
