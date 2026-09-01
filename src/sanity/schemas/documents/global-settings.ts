import { defineField, defineType } from "sanity";

import {
  CONTACT_POPUP_OFFER_CTA_LABEL_MAX_LENGTH,
  CONTACT_POPUP_OFFER_CTA_URL_MAX_LENGTH,
  CONTACT_POPUP_OFFER_LABEL_MAX_LENGTH,
  CONTACT_POPUP_OFFER_TERMS_MAX_LENGTH,
} from "@/lib/contact-popup/signup-offer-contract";

export const globalSettings = defineType({
  name: "globalSettings",
  title: "Global Settings",
  type: "document",
  groups: [
    { name: "site", title: "Site" },
    { name: "media", title: "Media" },
    { name: "navigation", title: "Navigation" },
    { name: "forms", title: "Forms" },
  ],
  fields: [
    defineField({
      name: "title",
      title: "Title",
      type: "string",
      group: "site",
    }),
    defineField({
      name: "description",
      title: "Description",
      type: "text",
      group: "site",
    }),
    defineField({
      name: "ogImage",
      title: "Open Graph Image",
      type: "image",
      group: "media",
      description: "Default social sharing image (recommended: 1200 x 630px)",
      options: { hotspot: false },
    }),
    defineField({
      name: "header",
      title: "Header",
      type: "header",
      group: "navigation",
    }),
    defineField({
      name: "footer",
      title: "Footer",
      type: "footer",
      group: "navigation",
    }),
    defineField({
      name: "contactPopup",
      title: "Contact Popup",
      type: "object",
      group: "forms",
      fields: [
        defineField({
          name: "enabled",
          title: "Enabled",
          type: "boolean",
          initialValue: false,
        }),
        defineField({
          name: "variant",
          title: "Variant",
          type: "string",
          options: {
            list: [
              {
                title: "Full Contact (Name, Email, Instagram)",
                value: "fullContact",
              },
              { title: "Email Only", value: "emailOnly" },
            ],
          },
          initialValue: "fullContact",
        }),
        defineField({
          name: "heading",
          title: "Heading",
          type: "string",
        }),
        defineField({
          name: "description",
          title: "Description",
          type: "text",
        }),
        defineField({
          name: "privacyText",
          title: "Privacy Agreement Text",
          type: "string",
        }),
        defineField({
          name: "privacyLinkLabel",
          title: "Privacy Link Label",
          type: "string",
        }),
        defineField({
          name: "privacyLinkHref",
          title: "Privacy Link URL",
          type: "string",
        }),
        defineField({
          name: "submitLabel",
          title: "Submit Button Label",
          type: "string",
        }),
        defineField({
          name: "successMessage",
          title: "Success Message",
          type: "string",
        }),
        defineField({
          name: "signupOfferEnabled",
          title: "Enable Signup Discount Offer",
          type: "boolean",
          initialValue: false,
          description:
            "Controls whether contact pop-up subscribers can receive a discount code in their welcome email. Turn it off to send the standard welcome email without an offer. A subscriber can receive the same selected promotion only once.",
        }),
        defineField({
          name: "signupPromotion",
          title: "Discount Code to Send",
          type: "reference",
          to: [{ type: "promotionCode" }],
          weak: false,
          hidden: ({ parent }) => parent?.signupOfferEnabled !== true,
          options: {
            filter: 'isEnabled == true && appliesTo == "all"',
          },
          description:
            "Select the Promotion Code that customers will see in the welcome email and enter at checkout. Only enabled codes that work on all products and training programs appear here. These codes do not apply to service appointments.",
          validation: (Rule) =>
            Rule.custom((value, context) => {
              if (!isSignupOfferEnabled(context.parent)) return true;

              return hasReference(value)
                ? true
                : "Select an enabled promotion that applies to all products and training programs.";
            }),
        }),
        defineField({
          name: "signupOfferLabel",
          title: "Offer Heading in Email",
          type: "string",
          hidden: ({ parent }) => parent?.signupOfferEnabled !== true,
          description:
            "This heading appears directly above the discount code. Use it to tell the customer what they are receiving, and make sure the amount matches the selected Promotion Code. For example: “Enjoy 15% off products and training.”",
          validation: (Rule) =>
            Rule.custom((value, context) =>
              validateRequiredOfferText(
                value,
                context.parent,
                "Signup offer label is required when the offer is enabled.",
                CONTACT_POPUP_OFFER_LABEL_MAX_LENGTH,
              ),
            ),
        }),
        defineField({
          name: "signupOfferTerms",
          title: "Offer Details in Email",
          type: "text",
          rows: 3,
          hidden: ({ parent }) => parent?.signupOfferEnabled !== true,
          description:
            "This smaller text appears below the email button. Use it for instructions or conditions customers need to know before using the code. This text does not change or enforce the Promotion Code settings, so it must accurately match the selected promotion.",
          validation: (Rule) =>
            Rule.custom((value, context) =>
              validateRequiredOfferText(
                value,
                context.parent,
                "Signup offer terms are required when the offer is enabled.",
                CONTACT_POPUP_OFFER_TERMS_MAX_LENGTH,
              ),
            ),
        }),
        defineField({
          name: "signupOfferCtaLabel",
          title: "Email Button Text",
          type: "string",
          hidden: ({ parent }) => parent?.signupOfferEnabled !== true,
          description:
            "This is the wording customers see on the button below their discount code. It should describe where the button leads. For example: “Shop products” or “View training programs.”",
          validation: (Rule) =>
            Rule.custom((value, context) =>
              validateRequiredOfferText(
                value,
                context.parent,
                "Signup offer CTA label is required when the offer is enabled.",
                CONTACT_POPUP_OFFER_CTA_LABEL_MAX_LENGTH,
              ),
            ),
        }),
        defineField({
          name: "signupOfferCtaUrl",
          title: "Email Button Destination",
          type: "url",
          hidden: ({ parent }) => parent?.signupOfferEnabled !== true,
          description:
            "This is the page that opens when a customer clicks the email button. Link to the best place to start using the code—usually the Products page, Training Programs page, or a dedicated offer page. Do not link to service booking because this promotion does not apply to services. Paste the full page address beginning with https://.",
          validation: (Rule) =>
            Rule.custom((value, context) => {
              if (!isSignupOfferEnabled(context.parent)) return true;
              if (typeof value !== "string" || value.trim().length === 0) {
                return "Signup offer CTA URL is required when the offer is enabled.";
              }
              if (
                value.trim().length > CONTACT_POPUP_OFFER_CTA_URL_MAX_LENGTH
              ) {
                return `Signup offer CTA URL must be ${CONTACT_POPUP_OFFER_CTA_URL_MAX_LENGTH} characters or fewer.`;
              }

              try {
                const url = new URL(value);
                return url.protocol === "https:" && Boolean(url.hostname)
                  ? true
                  : "Signup offer CTA URL must be an absolute HTTPS URL.";
              } catch {
                return "Signup offer CTA URL must be an absolute HTTPS URL.";
              }
            }),
        }),
        defineField({
          name: "cookieExpiryDays",
          title: "Cookie Expiry (Days)",
          type: "number",
          initialValue: 30,
          description:
            "How many days before the popup shows again after being dismissed or submitted.",
        }),
      ],
    }),
  ],
  preview: {
    select: {
      title: "title",
    },
  },
});

function isSignupOfferEnabled(parent: unknown): boolean {
  return (
    typeof parent === "object" &&
    parent !== null &&
    (parent as { signupOfferEnabled?: unknown }).signupOfferEnabled === true
  );
}

function hasReference(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { _ref?: unknown })._ref === "string" &&
    (value as { _ref: string })._ref.trim().length > 0
  );
}

function validateRequiredOfferText(
  value: unknown,
  parent: unknown,
  message: string,
  maxLength: number,
): true | string {
  if (!isSignupOfferEnabled(parent)) return true;
  if (typeof value !== "string" || value.trim().length === 0) return message;
  return value.trim().length <= maxLength
    ? true
    : `Must be ${maxLength} characters or fewer.`;
}
