import "server-only";

import {
  escapeHtml,
  getEmailConfig,
  mailtoHref,
  sendTransactionalEmail,
  telHref,
} from "@/lib/transactional-email";

// Type definitions
export interface GeneralInquiryData {
  name: string;
  email: string;
  phone?: string;
  instagram?: string;
  message: string;
  marketingConsent?: boolean;
  consentText?: string;
  sourcePath?: string;
}

export interface TrainingContactData {
  name: string;
  email: string;
  phone: string;
  location?: string;
  instagram?: string;
  programSlug: string;
  programTitle: string;
  marketingConsent?: boolean;
  consentText?: string;
  privacyPolicyConsent?: boolean;
  sourcePath?: string;
}

export interface ContactPopupData {
  variant?: "fullContact" | "emailOnly";
  name?: string;
  email: string;
  instagram?: string;
  sourcePath?: string;
  consentText?: string;
  company?: string;
}

export type FormType = "general-inquiry" | "training-contact" | "contact-popup";

// Subject line helpers
function getAdminSubject(
  formType: FormType,
  formData: GeneralInquiryData | TrainingContactData | ContactPopupData
): string {
  if (formType === "general-inquiry") {
    return `🔔 New General Inquiry from ${(formData as GeneralInquiryData).name}`;
  }
  if (formType === "contact-popup") {
    const name = (formData as ContactPopupData).name || "a visitor";
    return `✨ New Popup Lead from ${name}`;
  }
  const trainingData = formData as TrainingContactData;
  return `🎓 New ${trainingData.programTitle} Inquiry from ${trainingData.name}`;
}

function getUserSubject(formType: FormType, formData: GeneralInquiryData | TrainingContactData | ContactPopupData): string {
  if (formType === "general-inquiry") {
    return "Thank You for Your Inquiry - Lash Her by Nataliea";
  }
  if (formType === "contact-popup") {
    return "Welcome to Lash Her by Nataliea!";
  }
  return `Your ${(formData as TrainingContactData).programTitle} Inquiry - Lash Her by Nataliea`;
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
            <td style="background: linear-gradient(135deg, #1C1318 0%, #3D0B16 100%); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
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
              <div style="background-color: #F5F1F5; border-left: 4px solid #663976; padding: 15px; margin-bottom: 30px; border-radius: 4px;">
                <p style="margin: 0; color: #3D0B16; font-size: 14px; font-weight: 500;">
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
                    <a href="${escapeHtml(mailtoHref(data.email))}" style="color: #663976; font-size: 14px; text-decoration: none;">${escapeHtml(data.email)}</a>
                  </td>
                </tr>
                ${
                  data.phone
                    ? `
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 120px;">Phone:</strong>
                    <a href="${escapeHtml(telHref(data.phone))}" style="color: #663976; font-size: 14px; text-decoration: none;">${escapeHtml(data.phone)}</a>
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
                <a href="${escapeHtml(mailtoHref(data.email))}" style="display: inline-block; background-color: #663976; color: #ffffff; text-decoration: none; padding: 12px 30px; border-radius: 6px; font-weight: 500; font-size: 14px;">
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
            <td style="background: linear-gradient(135deg, #1C1318 0%, #663976 100%); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">
                🎓 New Training Inquiry
              </h1>
              <p style="margin: 10px 0 0 0; color: #FFFFFF; font-size: 14px;">
                Lash Her by Nataliea - Training Program
              </p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">

              <!-- Priority Alert -->
              <div style="background-color: #FFFFFF; border-left: 4px solid #D4B483; padding: 15px; margin-bottom: 30px; border-radius: 4px;">
                <p style="margin: 0; color: #3D0B16; font-size: 14px; font-weight: 500;">
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
                    <a href="${escapeHtml(mailtoHref(data.email))}" style="color: #663976; font-size: 14px; text-decoration: none;">${escapeHtml(data.email)}</a>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 140px;">Phone:</strong>
                    <a href="${escapeHtml(telHref(data.phone))}" style="color: #663976; font-size: 14px; text-decoration: none;">${escapeHtml(data.phone)}</a>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 140px;">Location:</strong>
                    <span style="color: #1f2937; font-size: 14px;">${escapeHtml(data.location ?? "Not provided")}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 140px;">Instagram:</strong>
                    <span style="color: #1f2937; font-size: 14px;">${data.instagram ? `@${escapeHtml(data.instagram)}` : "Not provided"}</span>
                  </td>
                </tr>
              </table>

              <!-- Training Details -->
              <h2 style="margin: 0 0 20px 0; color: #1f2937; font-size: 18px; font-weight: 600; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">
                Training Program
              </h2>

              <table role="presentation" style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 140px;">Program:</strong>
                    <span style="display: inline-block; background-color: #F5F1F5; color: #663976; padding: 4px 12px; border-radius: 12px; font-size: 13px; font-weight: 500;">${escapeHtml(data.programTitle)}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 140px;">Submitted Page:</strong>
                    <span style="color: #1f2937; font-size: 14px;">${escapeHtml(data.sourcePath ?? `/training-programs/${data.programSlug}`)}</span>
                  </td>
                </tr>
              </table>

              <!-- Action Buttons -->
              <div style="text-align: center; margin-top: 30px;">
                  <a href="${escapeHtml(mailtoHref(data.email))}" style="display: inline-block; background-color: #D4B483; color: #ffffff; text-decoration: none; padding: 12px 30px; border-radius: 6px; font-weight: 500; font-size: 14px; margin: 5px;">
                  Email ${escapeHtml(data.name.split(" ")[0])}
                </a>
                <a href="${escapeHtml(telHref(data.phone))}" style="display: inline-block; background-color: #663976; color: #ffffff; text-decoration: none; padding: 12px 30px; border-radius: 6px; font-weight: 500; font-size: 14px; margin: 5px;">
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
            <td style="background: linear-gradient(135deg, #1C1318 0%, #3D0B16 100%); padding: 40px 30px; text-align: center; border-radius: 8px 8px 0 0;">
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
                Thank you for contacting <strong style="color: #663976;">Lash Her by Nataliea</strong>. We've received your inquiry and are excited to connect with you!
              </p>

              <div style="background-color: #F5F1F5; border-left: 4px solid #663976; padding: 20px; margin: 30px 0; border-radius: 4px;">
                <p style="margin: 0; color: #3D0B16; font-size: 14px; line-height: 1.6;">
                  <strong>What's next?</strong><br>
                  We typically respond to all inquiries within 24 hours.
                </p>
              </div>

              <p style="margin: 30px 0 20px 0; color: #374151; font-size: 15px; line-height: 1.7;">
                In the meantime, feel free to explore our services and follow us on social media for the latest updates, tips, and beautiful lash transformations!
              </p>

              <!-- Social Links Section -->
              <div style="text-align: center; margin: 30px 0; padding: 20px; background-color: #F5F1F5; border-radius: 6px;">
                <p style="margin: 0 0 15px 0; color: #6b7280; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                  Connect With Us
                </p>
                <p style="margin: 0; color: #663976; font-size: 16px; font-weight: 500;">
                  <a href="https://instagram.com/lav_lashher" style="color: #D4B483; text-decoration: none;">@lav_lashher</a> <a href="https://lashher.com" style="color: #D4B483; text-decoration: none;">lashher.com</a>
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
            <td style="background: linear-gradient(135deg, #1C1318 0%, #663976 100%); padding: 40px 30px; text-align: center; border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600; font-family: 'Georgia', serif;">
                Lash Her by Nataliea
              </h1>
              <p style="margin: 15px 0 0 0; color: #FFFFFF; font-size: 18px; font-weight: 500;">
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
                Thank you for your interest in <strong style="color: #663976;">${escapeHtml(data.programTitle)}</strong> with Lash Her by Nataliea. We're thrilled that you're considering joining our lash artistry community.
              </p>

              <!-- Program Summary -->
              <div style="background-color: #FFFFFF; border-left: 4px solid #D4B483; padding: 20px; margin: 30px 0; border-radius: 4px;">
                <p style="margin: 0 0 10px 0; color: #3D0B16; font-size: 14px; font-weight: 600;">
                  Your Training Program:
                </p>
                <p style="margin: 0; color: #3D0B16; font-size: 15px; line-height: 1.6;">
                  <strong>${escapeHtml(data.programTitle)}</strong><br>
                  <span style="font-size: 13px; color: #663976;">Submitted from ${escapeHtml(data.sourcePath ?? `/training-programs/${data.programSlug}`)}</span>
                </p>
              </div>

              <div style="background-color: #F5F1F5; border: 1px solid #E8E2E9; padding: 20px; margin: 30px 0; border-radius: 6px;">
                <p style="margin: 0 0 15px 0; color: #3D0B16; font-size: 14px; font-weight: 600;">
                  ✅ What Happens Next:
                </p>
                <ul style="margin: 0; padding: 0 0 0 20px; color: #3D0B16; font-size: 14px; line-height: 1.8;">
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
              <div style="text-align: center; margin: 30px 0; padding: 25px; background: linear-gradient(135deg, #FFFFFF 0%, #F5F1F5 100%); border-radius: 8px;">
                <p style="margin: 0 0 10px 0; color: #3D0B16; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                  Follow Our Journey
                </p>
                <p style="margin: 0 0 5px 0; color: #663976; font-size: 17px; font-weight: 600;">
                  <a href="https://instagram.com/lav_lashher" style="color: #D4B483; text-decoration: none;">@lav_lashher</a> <a href="https://lashher.com" style="color: #D4B483; text-decoration: none;">lashher.com</a>
                </p>
                <p style="margin: 0; color: #3D0B16; font-size: 12px;">
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

// Admin notification template for contact popup
function getContactPopupAdminHtml(data: ContactPopupData): string {
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
  <title>New Popup Lead</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <tr>
            <td style="background: linear-gradient(135deg, #1C1318 0%, #3D0B16 100%); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">
                ✨ New Popup Lead
              </h1>
              <p style="margin: 10px 0 0 0; color: #f0f0f0; font-size: 14px;">
                Lash Her by Nataliea
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px 30px;">
              <h2 style="margin: 0 0 20px 0; color: #1f2937; font-size: 18px; font-weight: 600; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">
                Lead Details
              </h2>
              <table role="presentation" style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                ${data.name ? `
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 120px;">Name:</strong>
                    <span style="color: #1f2937; font-size: 14px;">${escapeHtml(data.name)}</span>
                  </td>
                </tr>` : ''}
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 120px;">Email:</strong>
                    <a href="${escapeHtml(mailtoHref(data.email))}" style="color: #663976; font-size: 14px; text-decoration: none;">${escapeHtml(data.email)}</a>
                  </td>
                </tr>
                ${data.instagram ? `
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 120px;">Instagram:</strong>
                    <span style="color: #1f2937; font-size: 14px;">@${escapeHtml(data.instagram)}</span>
                  </td>
                </tr>` : ''}
                ${data.sourcePath ? `
                <tr>
                  <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6;">
                    <strong style="color: #6b7280; font-size: 14px; display: inline-block; width: 120px;">Source Page:</strong>
                    <span style="color: #1f2937; font-size: 14px;">${escapeHtml(data.sourcePath)}</span>
                  </td>
                </tr>` : ''}
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color: #f9fafb; padding: 20px 30px; border-radius: 0 0 8px 8px; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; color: #6b7280; font-size: 12px; text-align: center;">
                Received on ${timestamp}
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

// User confirmation template for contact popup
function getContactPopupUserHtml(data: ContactPopupData): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Lash Her</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <tr>
            <td style="background: linear-gradient(135deg, #1C1318 0%, #3D0B16 100%); padding: 40px 30px; text-align: center; border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600; font-family: 'Georgia', serif;">
                Lash Her by Nataliea
              </h1>
              <p style="margin: 15px 0 0 0; color: #f0f0f0; font-size: 16px;">
                Welcome to our community!
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px 30px;">
              <p style="margin: 0 0 20px 0; color: #1f2937; font-size: 16px; line-height: 1.6;">
                Hi ${data.name ? escapeHtml(data.name.split(" ")[0]) : 'there'},
              </p>
              <p style="margin: 0 0 20px 0; color: #374151; font-size: 15px; line-height: 1.7;">
                Thank you for subscribing to <strong style="color: #663976;">Lash Her by Nataliea</strong>. We're excited to share our latest updates, tips, and beautiful lash transformations with you!
              </p>
              <div style="text-align: center; margin: 30px 0; padding: 20px; background-color: #F5F1F5; border-radius: 6px;">
                <p style="margin: 0 0 15px 0; color: #6b7280; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                  Connect With Us
                </p>
                <p style="margin: 0; color: #663976; font-size: 16px; font-weight: 500;">
                  <a href="https://instagram.com/lav_lashher" style="color: #D4B483; text-decoration: none;">@lav_lashher</a> <a href="https://lashher.com" style="color: #D4B483; text-decoration: none;">lashher.com</a>
                </p>
              </div>
            </td>
          </tr>
          <tr>
            <td style="background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin: 0 0 10px 0; color: #1f2937; font-size: 14px; font-weight: 500;">
                Lash Her by Nataliea
              </p>
              <p style="margin: 0; color: #6b7280; font-size: 13px; line-height: 1.5;">
                Professional Lash Artistry & Training
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
  formData: GeneralInquiryData | TrainingContactData | ContactPopupData
): Promise<void> {
  const config = getEmailConfig();
  const subject = getAdminSubject(formType, formData);
  let html = "";
  if (formType === "general-inquiry") {
    html = getGeneralInquiryAdminHtml(formData as GeneralInquiryData);
  } else if (formType === "contact-popup") {
    html = getContactPopupAdminHtml(formData as ContactPopupData);
  } else {
    html = getTrainingContactAdminHtml(formData as TrainingContactData);
  }

  await sendTransactionalEmail({
    html,
    subject,
    tags: [
      { name: "flow", value: `${formType}_admin` },
    ],
    to: config.adminEmail,
  });
}

export async function sendUserConfirmation(
  formType: FormType,
  formData: GeneralInquiryData | TrainingContactData | ContactPopupData
): Promise<void> {
  const subject = getUserSubject(formType, formData);
  let html = "";
  if (formType === "general-inquiry") {
    html = getGeneralInquiryUserHtml(formData as GeneralInquiryData);
  } else if (formType === "contact-popup") {
    html = getContactPopupUserHtml(formData as ContactPopupData);
  } else {
    html = getTrainingContactUserHtml(formData as TrainingContactData);
  }

  await sendTransactionalEmail({
    html,
    subject,
    tags: [
      { name: "flow", value: `${formType}_customer` },
    ],
    to: formData.email,
  });
}

export async function sendFormEmails(
  formType: FormType,
  formData: GeneralInquiryData | TrainingContactData | ContactPopupData
): Promise<void> {
  const results = await Promise.allSettled([
    sendAdminNotification(formType, formData),
    sendUserConfirmation(formType, formData),
  ]);
  const failures: string[] = [];

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const recipientType = index === 0 ? "admin" : "customer";
      const message = result.reason instanceof Error ? result.reason.message : "Unknown email error";

      failures.push(`${recipientType}: ${message}`);
      console.error("[email] Form email failed", {
        error: message,
        formType,
        recipientType,
      });
    }
  });

  if (failures.length > 0) {
    throw new Error(`Form email delivery failed for ${formType}: ${failures.join("; ")}`);
  }
}
