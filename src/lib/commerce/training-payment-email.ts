import "server-only";

import { getConfiguredTransactionalTemplate } from "@/lib/resend-platform";
import { CUSTOMER_REPLY_TO_EMAIL, escapeHtml, getEmailConfig, getEmailProfileImageHtml, sendTransactionalEmail } from "@/lib/transactional-email";

export interface SendTrainingPaymentNotificationEmailsInput {
  customerEmail: string;
  customerName: string;
  orderId: string;
  paymentProvider?: "helcim" | "square";
  programTitle: string;
  schedulingUrl: string;
}

export const TRAINING_PAYMENT_CUSTOMER_EMAIL_SUBJECT = "Your Lash Her training payment is confirmed";

export async function sendTrainingPaymentNotificationEmails(
  input: SendTrainingPaymentNotificationEmailsInput,
): Promise<void> {
  const [customerResult, adminResult] = await Promise.allSettled([
    sendTrainingCustomerPaymentEmail(input),
    sendTrainingAdminPaymentEmail(input),
  ]);

  handleEmailResult("customer training payment", customerResult);
  handleEmailResult("admin training payment", adminResult);
}

export async function sendTrainingCustomerPaymentEmail(
  input: SendTrainingPaymentNotificationEmailsInput,
): Promise<void> {
  await sendTransactionalEmail({
    html: getCustomerTrainingPaymentHtml(input),
    idempotencyKey: `training-customer:${input.orderId}`,
    replyTo: CUSTOMER_REPLY_TO_EMAIL,
    subject: TRAINING_PAYMENT_CUSTOMER_EMAIL_SUBJECT,
    tags: [
      { name: "flow", value: "training_payment_customer" },
      { name: "order_id", value: input.orderId },
      { name: "payment_provider", value: input.paymentProvider ?? "helcim" },
    ],
    template: getConfiguredTransactionalTemplate(
      "training_payment_customer",
      getTrainingPaymentTemplateVariables(input),
    ),
    to: input.customerEmail,
  });
}

export async function sendTrainingAdminPaymentEmail(
  input: SendTrainingPaymentNotificationEmailsInput,
): Promise<void> {
  await sendTransactionalEmail({
    html: getAdminTrainingPaymentHtml(input),
    idempotencyKey: `training-admin:${input.orderId}`,
    subject: `Training paid — scheduling pending — ${input.orderId}`,
    tags: [
      { name: "flow", value: "training_payment_admin" },
      { name: "order_id", value: input.orderId },
      { name: "payment_provider", value: input.paymentProvider ?? "helcim" },
    ],
    template: getConfiguredTransactionalTemplate(
      "training_payment_admin",
      getTrainingPaymentTemplateVariables(input),
    ),
    to: getEmailConfig().adminEmail,
  });
}

export function getTrainingPaymentTemplateVariables(
  input: SendTrainingPaymentNotificationEmailsInput,
): Record<string, unknown> {
  return {
    CUSTOMER_EMAIL: escapeHtml(input.customerEmail),
    CUSTOMER_FIRST_NAME: escapeHtml(input.customerName.trim().split(/\s+/)[0] ?? ""),
    CUSTOMER_NAME: escapeHtml(input.customerName),
    ORDER_ID: escapeHtml(input.orderId),
    PAYMENT_PROVIDER: escapeHtml(input.paymentProvider ?? "helcim"),
    PROGRAM_TITLE: escapeHtml(input.programTitle),
    SCHEDULING_URL: escapeHtml(input.schedulingUrl),
  };
}

export function getCustomerTrainingPaymentHtml(
  input: SendTrainingPaymentNotificationEmailsInput,
): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Lash Her training payment is confirmed</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F1F5;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1C1318;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" style="width:100%;max-width:600px;border-collapse:collapse;background-color:#FFFFFF;border:1px solid #E8E2E9;">
          <tr>
            <td style="padding:34px 32px;text-align:center;background-color:#1C1318;color:#FFFFFF;">
              ${getEmailProfileImageHtml()}
              <p style="margin:0 0 10px 0;font-size:12px;letter-spacing:0.22em;text-transform:uppercase;">Lash Her by Nataliea</p>
              <h1 style="margin:0;font-family:'Bebas Neue','Arial Narrow',Impact,sans-serif;letter-spacing:0.04em;text-transform:uppercase;font-size:30px;font-weight:500;line-height:1.2;">Training payment confirmed</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:34px 32px;">
              <p style="margin:0 0 18px 0;font-size:16px;line-height:1.7;">Hi ${escapeHtml(input.customerName)},</p>
              <p style="margin:0 0 22px 0;font-size:15px;line-height:1.7;">Your payment for <strong>${escapeHtml(input.programTitle)}</strong> is confirmed.</p>
              <p style="margin:0 0 22px 0;font-size:15px;line-height:1.7;">Please schedule your required training call using the secure booking link below.</p>
              <p style="margin:28px 0;text-align:center;">
                <a href="${escapeHtml(input.schedulingUrl)}" style="display:inline-block;padding:14px 24px;background-color:#1C1318;color:#FFFFFF;text-decoration:none;font-size:14px;letter-spacing:0.08em;text-transform:uppercase;">Schedule Training Call</a>
              </p>
              <p style="margin:0;font-size:13px;line-height:1.7;color:#746A72;">Order ${escapeHtml(input.orderId)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

export function getAdminTrainingPaymentHtml(
  input: SendTrainingPaymentNotificationEmailsInput,
): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Training payment received</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F1F5;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1C1318;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td style="padding:28px;">
        ${getEmailProfileImageHtml()}
        <h1 style="margin:0 0 18px 0;font-family:'Bebas Neue','Arial Narrow',Impact,sans-serif;letter-spacing:0.04em;text-transform:uppercase;font-size:26px;font-weight:500;">Training payment received</h1>
        <p style="margin:0 0 12px 0;line-height:1.6;"><strong>Status:</strong> paid — scheduling pending</p>
        <p style="margin:0 0 12px 0;line-height:1.6;"><strong>Purchaser:</strong> ${escapeHtml(input.customerName)} &lt;${escapeHtml(input.customerEmail)}&gt;</p>
        <p style="margin:0 0 12px 0;line-height:1.6;"><strong>Program:</strong> ${escapeHtml(input.programTitle)}</p>
        <p style="margin:0;line-height:1.6;"><strong>Order:</strong> ${escapeHtml(input.orderId)}</p>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

function handleEmailResult(
  label: string,
  result: PromiseSettledResult<void>,
): void {
  if (result.status === "rejected") {
    throw new Error(`${label} email failed: ${getErrorMessage(result.reason)}`);
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
