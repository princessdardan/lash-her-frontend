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

export interface SendTransactionalEmailInput {
  from?: string;
  html: string;
  idempotencyKey?: string;
  replyTo?: string | string[];
  subject: string;
  tags?: TransactionalEmailTag[];
  to: string | string[];
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
  const payload = {
    from: input.from ?? config.fromEmail,
    html: input.html,
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    subject: input.subject,
    tags: [
      ...(input.tags ?? []),
      { name: "environment", value: config.environment },
    ],
    to: input.to,
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
