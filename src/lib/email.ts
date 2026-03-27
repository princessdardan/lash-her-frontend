import { Resend } from "resend";

// Type definitions
export interface GeneralInquiryData {
  name: string;
  email: string;
  phone?: string;
  instagram?: string;
  message: string;
}

export interface TrainingContactData {
  name: string;
  email: string;
  phone: string;
  location: string;
  instagram: string;
  experience: string;
  interest: string;
  clients?: number;
  info?: string;
}

export type FormType = "general-inquiry" | "training-contact";

// Resend client initialized at module level
const resend = new Resend(process.env.RESEND_API_KEY);

// HTML escape utility
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

// Subject line helpers
function getAdminSubject(
  formType: FormType,
  formData: GeneralInquiryData | TrainingContactData
): string {
  if (formType === "general-inquiry") {
    return `🔔 New General Inquiry from ${formData.name}`;
  }
  return `🎓 New Training Inquiry from ${formData.name}`;
}

function getUserSubject(formType: FormType): string {
  if (formType === "general-inquiry") {
    return "Thank You for Your Inquiry - Lash Her by Nataliea";
  }
  return "Your Training Inquiry - Lash Her by Nataliea";
}

// Admin notification template for general inquiry
function getGeneralInquiryAdminHtml(data: GeneralInquiryData): string {
  const timestamp = new Date().toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "short",
  });

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New General Inquiry</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #b14644 0%, #8f2e2d 100%); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">
                New General Inquiry
              </h1>
              <p style="margin: 10px 0 0 0; color: #f0f0f0; font-size: 14px;">
                Lash Her by Nataliea
              </p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">

              <!-- Alert Box -->
              <div style="background-color: #fef3f5; border-left: 4px solid #b14644; padding: 15px; margin-bottom: 30px; border-radius: 4px;">
                <p style="margin: 0; color: #8f2e2d; font-size: 14px; font-weight: 500;">
                  🔔 New inquiry received - please respond within 24 hours
                </p>
              </div>

              <!-- Customer Details -->
              <h2 style="margin: 0 0 20px 0; color: #1f2937; font-size: 18px; font-weight: 600; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">
                Customer Details
              </h2>

              <table role="presentation" style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 120px;">Name:</strong>
                    <span style="color: #1f2937; font-size: 14px;">${escapeHtml(data.name)}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 120px;">Email:</strong>
                    <a href="mailto:${data.email}" style="color: #b14644; font-size: 14px; text-decoration: none;">${data.email}</a>
                  </td>
                </tr>
                ${
                  data.phone
                    ? `
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 120px;">Phone:</strong>
                    <a href="tel:${data.phone}" style="color: #b14644; font-size: 14px; text-decoration: none;">${escapeHtml(data.phone)}</a>
                  </td>
                </tr>
                `
                    : ""
                }
                ${
                  data.instagram
                    ? `
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 120px;">Instagram:</strong>
                    <span style="color: #1f2937; font-size: 14px;">@${escapeHtml(data.instagram)}</span>
                  </td>
                </tr>
                `
                    : ""
                }
              </table>

              <!-- Message -->
              <h2 style="margin: 0 0 15px 0; color: #1f2937; font-size: 18px; font-weight: 600; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">
                Message
              </h2>
              <div style="background-color: #f9fafb; padding: 20px; border-radius: 6px; border: 1px solid #e5e7eb; margin-bottom: 30px;">
                <p style="margin: 0; color: #374151; font-size: 14px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(data.message)}</p>
              </div>

              <!-- Action Button -->
              <div style="text-align: center; margin-top: 30px;">
                <a href="mailto:${data.email}" style="display: inline-block; background-color: #b14644; color: #ffffff; text-decoration: none; padding: 12px 30px; border-radius: 6px; font-weight: 500; font-size: 14px;">
                  Reply to ${escapeHtml(data.name.split(" ")[0])}
                </a>
              </div>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 20px 30px; border-radius: 0 0 8px 8px; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; color: #6b7280; font-size: 12px; text-align: center;">
                Received on ${timestamp}
              </p>
              <p style="margin: 10px 0 0 0; color: #9ca3af; font-size: 11px; text-align: center;">
                This notification was sent from your Lash Her website contact form
              </p>
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

// Admin notification template for training contact
function getTrainingContactAdminHtml(data: TrainingContactData): string {
  const timestamp = new Date().toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "short",
  });

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Training Inquiry</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #e8c870 0%, #b8a055 100%); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">
                🎓 New Training Inquiry
              </h1>
              <p style="margin: 10px 0 0 0; color: #fffef9; font-size: 14px;">
                Lash Her by Nataliea - Training Program
              </p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">

              <!-- Priority Alert -->
              <div style="background-color: #fffef9; border-left: 4px solid #e8c870; padding: 15px; margin-bottom: 30px; border-radius: 4px;">
                <p style="margin: 0; color: #8f2e2d; font-size: 14px; font-weight: 500;">
                  ⚡ Priority: Training inquiry - Contact within 12 hours
                </p>
              </div>

              <!-- Student Details -->
              <h2 style="margin: 0 0 20px 0; color: #1f2937; font-size: 18px; font-weight: 600; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">
                Student Information
              </h2>

              <table role="presentation" style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 140px;">Name:</strong>
                    <span style="color: #1f2937; font-size: 14px;">${escapeHtml(data.name)}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 140px;">Email:</strong>
                    <a href="mailto:${data.email}" style="color: #b14644; font-size: 14px; text-decoration: none;">${data.email}</a>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 140px;">Phone:</strong>
                    <a href="tel:${data.phone}" style="color: #b14644; font-size: 14px; text-decoration: none;">${escapeHtml(data.phone)}</a>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 140px;">Location:</strong>
                    <span style="color: #1f2937; font-size: 14px;">${escapeHtml(data.location)}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 140px;">Instagram:</strong>
                    <span style="color: #1f2937; font-size: 14px;">@${escapeHtml(data.instagram)}</span>
                  </td>
                </tr>
              </table>

              <!-- Training Details -->
              <h2 style="margin: 0 0 20px 0; color: #1f2937; font-size: 18px; font-weight: 600; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">
                Training Interest
              </h2>

              <table role="presentation" style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 140px;">Experience Level:</strong>
                    <span style="display: inline-block; background-color: ${data.experience.includes("Beginner") ? "#fef3f5" : "#fffef9"}; color: ${data.experience.includes("Beginner") ? "#b14644" : "#8f2e2d"}; padding: 4px 12px; border-radius: 12px; font-size: 13px; font-weight: 500;">
                      ${escapeHtml(data.experience)}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 140px;">Program Interest:</strong>
                    <span style="display: inline-block; background-color: #f4d6db; color: #8f2e2d; padding: 4px 12px; border-radius: 12px; font-size: 13px; font-weight: 500;">
                      ${escapeHtml(data.interest)}
                    </span>
                  </td>
                </tr>
                ${
                  data.clients !== undefined && data.clients !== null
                    ? `
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 140px;">Current Clients:</strong>
                    <span style="color: #1f2937; font-size: 14px; font-weight: 500;">${data.clients} clients</span>
                  </td>
                </tr>
                `
                    : ""
                }
              </table>

              <!-- Additional Info -->
              ${
                data.info
                  ? `
              <h2 style="margin: 0 0 15px 0; color: #1f2937; font-size: 18px; font-weight: 600; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">
                Additional Information
              </h2>
              <div style="background-color: #f9fafb; padding: 20px; border-radius: 6px; border: 1px solid #e5e7eb; margin-bottom: 30px;">
                <p style="margin: 0; color: #374151; font-size: 14px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(data.info)}</p>
              </div>
              `
                  : ""
              }

              <!-- Action Buttons -->
              <div style="text-align: center; margin-top: 30px;">
                <a href="mailto:${data.email}" style="display: inline-block; background-color: #e8c870; color: #ffffff; text-decoration: none; padding: 12px 30px; border-radius: 6px; font-weight: 500; font-size: 14px; margin: 5px;">
                  Email ${escapeHtml(data.name.split(" ")[0])}
                </a>
                <a href="tel:${data.phone}" style="display: inline-block; background-color: #b14644; color: #ffffff; text-decoration: none; padding: 12px 30px; border-radius: 6px; font-weight: 500; font-size: 14px; margin: 5px;">
                  Call ${escapeHtml(data.name.split(" ")[0])}
                </a>
              </div>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 20px 30px; border-radius: 0 0 8px 8px; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; color: #6b7280; font-size: 12px; text-align: center;">
                Received on ${timestamp}
              </p>
              <p style="margin: 10px 0 0 0; color: #9ca3af; font-size: 11px; text-align: center;">
                Training inquiry from Lash Her by Nataliea website
              </p>
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

// User confirmation template for general inquiry
function getGeneralInquiryUserHtml(data: GeneralInquiryData): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thank You for Your Inquiry</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #b14644 0%, #8f2e2d 100%); padding: 40px 30px; text-align: center; border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600; font-family: 'Georgia', serif;">
                Lash Her by Nataliea
              </h1>
              <p style="margin: 15px 0 0 0; color: #f0f0f0; font-size: 16px;">
                Thank you for reaching out!
              </p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">

              <p style="margin: 0 0 20px 0; color: #1f2937; font-size: 16px; line-height: 1.6;">
                Hi ${escapeHtml(data.name.split(" ")[0])},
              </p>

              <p style="margin: 0 0 20px 0; color: #374151; font-size: 15px; line-height: 1.7;">
                Thank you for contacting <strong style="color: #b14644;">Lash Her by Nataliea</strong>. We've received your inquiry and are excited to connect with you!
              </p>

              <div style="background-color: #fef3f5; border-left: 4px solid #b14644; padding: 20px; margin: 30px 0; border-radius: 4px;">
                <p style="margin: 0; color: #8f2e2d; font-size: 14px; line-height: 1.6;">
                  <strong>What's next?</strong><br>
                  We typically respond to all inquiries within 24 hours.
                </p>
              </div>

              <p style="margin: 30px 0 20px 0; color: #374151; font-size: 15px; line-height: 1.7;">
                In the meantime, feel free to explore our services and follow us on social media for the latest updates, tips, and beautiful lash transformations!
              </p>

              <!-- Social Links Section -->
              <div style="text-align: center; margin: 30px 0; padding: 20px; background-color: #fef3f5; border-radius: 6px;">
                <p style="margin: 0 0 15px 0; color: #6b7280; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                  Connect With Us
                </p>
                <p style="margin: 0; color: #b14644; font-size: 16px; font-weight: 500;">
                  <a href="https://instagram.com/lav_lashher" style="color: #e54f7d; text-decoration: none;">@lav_lashher</a> <a href="https://lashher.com" style="color: #e54f7d; text-decoration: none;">lashher.com</a>
                </p>
              </div>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin: 0 0 10px 0; color: #1f2937; font-size: 14px; font-weight: 500;">
                Lash Her by Nataliea
              </p>
              <p style="margin: 0; color: #6b7280; font-size: 13px; line-height: 1.5;">
                Professional Lash Artistry & Training
              </p>
              <p style="margin: 15px 0 0 0; color: #9ca3af; font-size: 12px;">
                This is an automated confirmation email. Please do not reply directly to this message.
              </p>
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

// User confirmation template for training contact
function getTrainingContactUserHtml(data: TrainingContactData): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Training Inquiry</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #e8c870 0%, #b8a055 100%); padding: 40px 30px; text-align: center; border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600; font-family: 'Georgia', serif;">
                Lash Her by Nataliea
              </h1>
              <p style="margin: 15px 0 0 0; color: #fffef9; font-size: 18px; font-weight: 500;">
                🎓 Training Academy
              </p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">

              <p style="margin: 0 0 20px 0; color: #1f2937; font-size: 16px; line-height: 1.6;">
                Hi ${escapeHtml(data.name.split(" ")[0])},
              </p>

              <p style="margin: 0 0 20px 0; color: #374151; font-size: 15px; line-height: 1.7;">
                Thank you for your interest in training with <strong style="color: #b14644;">Lash Her by Nataliea</strong>! We're thrilled that you're considering joining our lash artistry community.
              </p>

              <!-- Program Summary -->
              <div style="background-color: #fffef9; border-left: 4px solid #e8c870; padding: 20px; margin: 30px 0; border-radius: 4px;">
                <p style="margin: 0 0 10px 0; color: #8f2e2d; font-size: 14px; font-weight: 600;">
                  Your Training Interest:
                </p>
                <p style="margin: 0; color: #8f2e2d; font-size: 15px; line-height: 1.6;">
                  <strong>${escapeHtml(data.interest)}</strong><br>
                  <span style="font-size: 13px; color: #b14644;">Experience Level: ${escapeHtml(data.experience)}</span>
                </p>
              </div>

              <div style="background-color: #fef3f5; border: 1px solid #f4d6db; padding: 20px; margin: 30px 0; border-radius: 6px;">
                <p style="margin: 0 0 15px 0; color: #8f2e2d; font-size: 14px; font-weight: 600;">
                  ✅ What Happens Next:
                </p>
                <ul style="margin: 0; padding: 0 0 0 20px; color: #8f2e2d; font-size: 14px; line-height: 1.8;">
                  <li>We'll review your inquiry within 24 hours</li>
                  <li>You'll receive a personal response with program details</li>
                  <li>We'll discuss scheduling and next steps</li>
                  <li>All your questions will be answered!</li>
                </ul>
              </div>

              <p style="margin: 30px 0 20px 0; color: #374151; font-size: 15px; line-height: 1.7;">
                Training with us means joining a community of passionate lash artists dedicated to excellence. We can't wait to help you achieve your goals!
              </p>

              <!-- Social Section -->
              <div style="text-align: center; margin: 30px 0; padding: 25px; background: linear-gradient(135deg, #fffef9 0%, #f9f6ee 100%); border-radius: 8px;">
                <p style="margin: 0 0 10px 0; color: #8f2e2d; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                  Follow Our Journey
                </p>
                <p style="margin: 0 0 5px 0; color: #b14644; font-size: 17px; font-weight: 600;">
                  <a href="https://instagram.com/lav_lashher" style="color: #e54f7d; text-decoration: none;">@lav_lashher</a> <a href="https://lashher.com" style="color: #e54f7d; text-decoration: none;">lashher.com</a>
                </p>
                <p style="margin: 0; color: #8f2e2d; font-size: 12px;">
                  See student transformations & success stories
                </p>
              </div>

              <p style="margin: 30px 0 0 0; color: #6b7280; font-size: 14px; line-height: 1.6; text-align: center;">
                Questions in the meantime?<br>
                <span style="color: #374151; font-weight: 500;">We're here to help every step of the way!</span>
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin: 0 0 10px 0; color: #1f2937; font-size: 14px; font-weight: 500;">
                Lash Her by Nataliea
              </p>
              <p style="margin: 0; color: #6b7280; font-size: 13px; line-height: 1.5;">
                Professional Lash Training & Artistry
              </p>
              <p style="margin: 15px 0 0 0; color: #9ca3af; font-size: 12px;">
                This is an automated confirmation email. Please do not reply directly to this message.
              </p>
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

// Exported email functions

export async function sendAdminNotification(
  formType: FormType,
  formData: GeneralInquiryData | TrainingContactData
): Promise<void> {
  const subject = getAdminSubject(formType, formData);
  const html =
    formType === "general-inquiry"
      ? getGeneralInquiryAdminHtml(formData as GeneralInquiryData)
      : getTrainingContactAdminHtml(formData as TrainingContactData);

  const { error } = await resend.emails.send({
    from: process.env.FROM_EMAIL!,
    to: process.env.ADMIN_EMAIL!,
    subject,
    html,
  });

  if (error) {
    throw new Error(`Admin notification failed: ${error.message}`);
  }
}

export async function sendUserConfirmation(
  formType: FormType,
  formData: GeneralInquiryData | TrainingContactData
): Promise<void> {
  const subject = getUserSubject(formType);
  const html =
    formType === "general-inquiry"
      ? getGeneralInquiryUserHtml(formData as GeneralInquiryData)
      : getTrainingContactUserHtml(formData as TrainingContactData);

  const { error } = await resend.emails.send({
    from: process.env.FROM_EMAIL!,
    to: formData.email,
    subject,
    html,
  });

  if (error) {
    throw new Error(`User confirmation failed: ${error.message}`);
  }
}

export async function sendFormEmails(
  formType: FormType,
  formData: GeneralInquiryData | TrainingContactData
): Promise<void> {
  await Promise.allSettled([
    sendAdminNotification(formType, formData),
    sendUserConfirmation(formType, formData),
  ]);
}
