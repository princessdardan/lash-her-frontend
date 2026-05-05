import "server-only";

import { Resend } from "resend";

export interface SendBookingConfirmationInput {
  name: string;
  email: string;
  bookingTypeLabel: string;
  start: Date;
  timezone: string;
}

export async function sendBookingConfirmationEmail(
  input: SendBookingConfirmationInput,
): Promise<void> {
  const resend = new Resend(getRequiredEnv("RESEND_API_KEY"));
  const fromEmail = getRequiredEnv("FROM_EMAIL");
  const formattedStart = new Intl.DateTimeFormat("en-CA", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: input.timezone,
  }).format(input.start);

  const { error } = await resend.emails.send({
    from: fromEmail,
    to: input.email,
    subject: "Your Lash Her booking is confirmed",
    html: getBookingConfirmationHtml({ ...input, formattedStart }),
  });

  if (error) {
    throw new Error(`Booking confirmation email failed: ${error.message}`);
  }
}

interface BookingConfirmationHtmlInput extends SendBookingConfirmationInput {
  formattedStart: string;
}

function getBookingConfirmationHtml(input: BookingConfirmationHtmlInput): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Lash Her booking is confirmed</title>
</head>
<body style="margin:0;padding:0;background-color:#f9f6ee;font-family:Inter,Arial,sans-serif;color:#2b1714;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" style="width:100%;max-width:600px;border-collapse:collapse;background-color:#fffaf1;border:1px solid #e8dcc8;">
          <tr>
            <td style="padding:34px 32px;text-align:center;background-color:#4b1230;color:#fffaf1;">
              <p style="margin:0 0 10px 0;font-size:12px;letter-spacing:0.22em;text-transform:uppercase;">Lash Her by Nataliea</p>
              <h1 style="margin:0;font-family:Georgia,serif;font-size:30px;font-weight:500;line-height:1.2;">Your booking is confirmed</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:34px 32px;">
              <p style="margin:0 0 18px 0;font-size:16px;line-height:1.7;">Hi ${escapeHtml(input.name)},</p>
              <p style="margin:0 0 22px 0;font-size:15px;line-height:1.7;">Your ${escapeHtml(input.bookingTypeLabel)} with Lash Her is reserved for <strong>${escapeHtml(input.formattedStart)}</strong>.</p>
              <div style="margin:28px 0;padding:20px;border-left:4px solid #8b6f47;background-color:#f4ead8;">
                <p style="margin:0;font-size:14px;line-height:1.7;">If you need to make a change, please contact Lash Her directly so we can help adjust your appointment.</p>
              </div>
              <p style="margin:0;font-size:15px;line-height:1.7;">We look forward to connecting with you.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px;text-align:center;background-color:#2b1714;color:#f9f6ee;">
              <p style="margin:0;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;">Quiet luxury lash artistry</p>
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
