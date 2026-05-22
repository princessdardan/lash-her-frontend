import "server-only";

import { Resend } from "resend";

export interface SendTrainingPaymentNotificationEmailsInput {
  customerEmail: string;
  customerName: string;
  orderId: string;
  programTitle: string;
  schedulingUrl: string;
}

export async function sendTrainingPaymentNotificationEmails(
  input: SendTrainingPaymentNotificationEmailsInput,
): Promise<void> {
  const resend = new Resend(getRequiredEnv("RESEND_API_KEY"));
  const fromEmail = getRequiredEnv("FROM_EMAIL");
  const adminEmail = getRequiredEnv("ADMIN_EMAIL");

  const [customerResult, adminResult] = await Promise.allSettled([
    resend.emails.send({
      from: fromEmail,
      to: input.customerEmail,
      subject: "Your Lash Her training payment is confirmed",
      html: getCustomerTrainingPaymentHtml(input),
    }),
    resend.emails.send({
      from: fromEmail,
      to: adminEmail,
      subject: `Training paid — scheduling pending — ${input.orderId}`,
      html: getAdminTrainingPaymentHtml(input),
    }),
  ]);

  handleEmailResult("customer training payment", customerResult);
  handleEmailResult("admin training payment", adminResult);
}

function getCustomerTrainingPaymentHtml(
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
<body style="margin:0;padding:0;background-color:#f9f6ee;font-family:Inter,Arial,sans-serif;color:#2b1714;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" style="width:100%;max-width:600px;border-collapse:collapse;background-color:#fffaf1;border:1px solid #e8dcc8;">
          <tr>
            <td style="padding:34px 32px;text-align:center;background-color:#4b1230;color:#fffaf1;">
              <p style="margin:0 0 10px 0;font-size:12px;letter-spacing:0.22em;text-transform:uppercase;">Lash Her by Nataliea</p>
              <h1 style="margin:0;font-family:Georgia,serif;font-size:30px;font-weight:500;line-height:1.2;">Training payment confirmed</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:34px 32px;">
              <p style="margin:0 0 18px 0;font-size:16px;line-height:1.7;">Hi ${escapeHtml(input.customerName)},</p>
              <p style="margin:0 0 22px 0;font-size:15px;line-height:1.7;">Your payment for <strong>${escapeHtml(input.programTitle)}</strong> is confirmed.</p>
              <p style="margin:0 0 22px 0;font-size:15px;line-height:1.7;">Please schedule your required training call using the secure booking link below.</p>
              <p style="margin:28px 0;text-align:center;">
                <a href="${escapeHtml(input.schedulingUrl)}" style="display:inline-block;padding:14px 24px;background-color:#4b1230;color:#fffaf1;text-decoration:none;font-size:14px;letter-spacing:0.08em;text-transform:uppercase;">Schedule Training Call</a>
              </p>
              <p style="margin:0;font-size:13px;line-height:1.7;color:#6f5d55;">Order ${escapeHtml(input.orderId)}</p>
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

function getAdminTrainingPaymentHtml(
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
<body style="margin:0;padding:0;background-color:#f9f6ee;font-family:Inter,Arial,sans-serif;color:#2b1714;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td style="padding:28px;">
        <h1 style="margin:0 0 18px 0;font-family:Georgia,serif;font-size:26px;font-weight:500;">Training payment received</h1>
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
  result: PromiseSettledResult<{ error: { message: string } | null }>,
): void {
  if (result.status === "rejected") {
    throw new Error(`${label} email failed: ${getErrorMessage(result.reason)}`);
  }

  if (result.value.error !== null) {
    throw new Error(`${label} email failed: ${result.value.error.message}`);
  }
}

function escapeHtml(text: string): string {
  const replacements: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };

  return text.replace(/[&<>"']/g, (character) => replacements[character] ?? character);
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
