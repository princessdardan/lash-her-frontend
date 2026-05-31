import "server-only";

import { Resend } from "resend";

export interface TransactionalEmailTag {
  name: string;
  value: string;
}

export const CUSTOMER_REPLY_TO_EMAIL = "lashher@outlook.com";

export interface EmailConfig {
  adminEmail: string;
  environment: string;
  fromEmail: string;
}

const EMAIL_PROFILE_IMAGE_URL_ENV = "EMAIL_PROFILE_IMAGE_URL";

export interface SendTransactionalEmailInput {
  from?: string;
  html?: string;
  idempotencyKey?: string;
  replyTo?: string | string[];
  subject: string;
  tags?: TransactionalEmailTag[];
  template?: TransactionalEmailTemplate;
  to: string | string[];
}

export type TransactionalEmailTemplateVariables = Record<string, string | number>;

export interface TransactionalEmailTemplate {
  id: string;
  variables?: TransactionalEmailTemplateVariables;
}

export interface SendTransactionalEmailResult {
  id: string;
}

let resendClient: Resend | null = null;

export function getEmailConfig(): EmailConfig {
  return {
    adminEmail: getRequiredEnv("ADMIN_EMAIL"),
    environment: getTransactionalEmailEnvironment(),
    fromEmail: getRequiredEnv("FROM_EMAIL"),
  };
}

export function getResendClient(): Resend {
  if (resendClient === null) {
    resendClient = new Resend(getRequiredEnv("RESEND_API_KEY"));
  }

  return resendClient;
}

export async function sendTransactionalEmail(
  input: SendTransactionalEmailInput,
): Promise<SendTransactionalEmailResult> {
  const config = getEmailConfig();
  if (input.template === undefined && input.html === undefined) {
    throw new Error("Transactional email requires html or a Resend template");
  }

  const basePayload = {
    from: input.from ?? config.fromEmail,
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    tags: [
      ...(input.tags ?? []),
      { name: "environment", value: config.environment },
    ],
    to: input.to,
  };
  const payload = input.template === undefined
    ? {
        ...basePayload,
        html: getRequiredEmailHtml(input.html),
        subject: input.subject,
      }
    : {
        ...basePayload,
        template: input.template,
      };
  const options = input.idempotencyKey === undefined
    ? undefined
    : { idempotencyKey: input.idempotencyKey };
  const result = options === undefined
    ? await getResendClient().emails.send(payload)
    : await getResendClient().emails.send(payload, options);

  if (result.error !== null) {
    throw new Error(result.error.message);
  }

  if (result.data === null) {
    throw new Error("Resend did not return an email id");
  }

  return { id: result.data.id };
}

function getRequiredEmailHtml(html: string | undefined): string {
  if (html === undefined) {
    throw new Error("Transactional email requires html or a Resend template");
  }

  return html;
}

export function escapeHtml(text: string): string {
  const replacements: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };

  return text.replace(/[&<>"']/g, (character) => replacements[character] ?? character);
}

export function getEmailProfileImageHtml(): string {
  const profileImageUrl = getOptionalEnv(EMAIL_PROFILE_IMAGE_URL_ENV);

  if (profileImageUrl === undefined) {
    return "";
  }

  return `
<div style="margin:0 auto 18px auto;width:72px;height:72px;border-radius:999px;overflow:hidden;border:1px solid rgba(245,241,245,0.45);">
  <img src="${escapeHtml(profileImageUrl)}" width="72" height="72" alt="Lash Her by Nataliea profile picture" style="display:block;width:72px;height:72px;border:0;border-radius:999px;object-fit:cover;">
</div>
  `.trim();
}

export function mailtoHref(email: string): string {
  return `mailto:${encodeURIComponent(email)}`;
}

export function telHref(phone: string): string {
  const sanitized = phone.trim().replace(/[^+\d]/g, "");
  return `tel:${encodeURIComponent(sanitized)}`;
}

export function getTransactionalEmailEnvironment(): string {
  return process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();

  if (value === undefined || value.length === 0) {
    return undefined;
  }

  return value;
}
