'use server'

import { sendFormEmails } from '@/lib/email'
import type { GeneralInquiryData, TrainingContactData, ContactPopupData } from '@/lib/email'
import { validateForm, type FieldValidationConfig } from '@/lib/form-validation'
import {
  CONTACT_POPUP_CONSENT_TEXT,
  GENERAL_INQUIRY_CONSENT_TEXT,
  recordContactPopupSubmission,
  recordGeneralInquirySubmission,
  recordTrainingContactSubmission,
  TRAINING_CONTACT_CONSENT_TEXT,
} from '@/lib/marketing-contact/marketing-contact-store'

export interface FormActionResult {
  success: boolean
  error?: string
  fieldErrors?: Record<string, string>
}

const FORM_EMAIL_FAILURE_MESSAGE = 'Your submission was saved, but we could not send the confirmation email. Please contact us directly if you do not hear back soon.'

const GENERAL_INQUIRY_VALIDATION: FieldValidationConfig = {
  name: [{ type: 'required', message: 'Name is required' }],
  email: [
    { type: 'required', message: 'Email is required' },
    { type: 'email', message: 'Please enter a valid email address' },
  ],
  message: [{ type: 'required', message: 'Message is required' }],
}

const TRAINING_CONTACT_VALIDATION: FieldValidationConfig = {
  name: [{ type: 'required', message: 'Name is required' }],
  email: [
    { type: 'required', message: 'Email is required' },
    { type: 'email', message: 'Please enter a valid email address' },
  ],
  phone: [
    { type: 'required', message: 'Phone number is required' },
    { type: 'phone', message: 'Please enter a valid phone number' },
  ],
  privacyPolicyConsent: [{ type: 'required', message: 'You must agree to the privacy policy to continue' }],
}

const CONTACT_POPUP_VALIDATION: FieldValidationConfig = {
  email: [
    { type: 'required', message: 'Email is required' },
    { type: 'email', message: 'Please enter a valid email address' },
  ],
}

const CONTACT_POPUP_FULL_VALIDATION: FieldValidationConfig = {
  name: [{ type: 'required', message: 'Name is required' }],
  ...CONTACT_POPUP_VALIDATION,
}

const CONTACT_POPUP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
const CONTACT_POPUP_RATE_LIMIT_MAX = 3
const contactPopupSubmissionsByEmail = new Map<string, number[]>()

function isContactPopupRateLimited(email: string) {
  const now = Date.now()
  const normalizedEmail = email.trim().toLowerCase()
  const recentSubmissions = (contactPopupSubmissionsByEmail.get(normalizedEmail) ?? []).filter(
    (submittedAt) => now - submittedAt < CONTACT_POPUP_RATE_LIMIT_WINDOW_MS
  )

  if (recentSubmissions.length >= CONTACT_POPUP_RATE_LIMIT_MAX) {
    contactPopupSubmissionsByEmail.set(normalizedEmail, recentSubmissions)
    return true
  }

  contactPopupSubmissionsByEmail.set(normalizedEmail, [...recentSubmissions, now])
  return false
}

export async function submitContactPopup(
  data: ContactPopupData
): Promise<FormActionResult> {
  if (data.company) {
    return { success: true }
  }

  const isFullContact = data.variant === 'fullContact'
  const { errors, isValid } = validateForm(
    { name: data.name ?? '', email: data.email },
    isFullContact ? CONTACT_POPUP_FULL_VALIDATION : CONTACT_POPUP_VALIDATION
  )
  if (!isValid) {
    return { success: false, error: 'Please fix the form errors and try again.', fieldErrors: errors }
  }

  if (isContactPopupRateLimited(data.email)) {
    return { success: false, error: 'Too many submissions. Please try again later.' }
  }

  try {
    await recordContactPopupSubmission({
      variant: data.variant ?? 'emailOnly',
      name: data.name || undefined,
      email: data.email,
      instagram: data.instagram || undefined,
      sourcePath: data.sourcePath || undefined,
      consentText: data.consentText ?? CONTACT_POPUP_CONSENT_TEXT,
    })
  } catch (err) {
    console.error('[submitContactPopup] Private DB write failed:', err instanceof Error ? err.message : String(err))
    return { success: false, error: 'Something went wrong, please try again.' }
  }

  const emailResult = await sendSavedFormEmails('contact-popup', data, '[submitContactPopup] Form email delivery failed')

  if (!emailResult.success) {
    return emailResult
  }

  return { success: true }
}
export async function submitGeneralInquiry(
  data: GeneralInquiryData
): Promise<FormActionResult> {
  // D-03: Server-side re-validation with field-level errors
  const { errors, isValid } = validateForm(
    { name: data.name, email: data.email, message: data.message, phone: data.phone ?? '', instagram: data.instagram ?? '' },
    GENERAL_INQUIRY_VALIDATION
  )
  if (!isValid) {
    return { success: false, error: 'Please fix the form errors and try again.', fieldErrors: errors }
  }

  // D-07: Sanity write -- failure blocks email send, returns generic error
  try {
    await recordGeneralInquirySubmission({
      name: data.name,
      email: data.email,
      phone: data.phone || undefined,
      instagram: data.instagram || undefined,
      message: data.message,
      marketingConsent: data.marketingConsent === true,
      consentText: data.consentText ?? GENERAL_INQUIRY_CONSENT_TEXT,
      sourcePath: data.sourcePath || undefined,
    })
  } catch (err) {
    console.error('[submitGeneralInquiry] Private DB write failed:', err instanceof Error ? err.message : String(err))
    return { success: false, error: 'Something went wrong, please try again.' }
  }

  const emailResult = await sendSavedFormEmails('general-inquiry', data, '[submitGeneralInquiry] Form email delivery failed')

  if (!emailResult.success) {
    return emailResult
  }

  return { success: true }
}

export async function submitTrainingContact(
  data: TrainingContactData
): Promise<FormActionResult> {
  // D-03: Server-side re-validation with field-level errors
  const { errors, isValid } = validateForm(
    {
      name: data.name,
      email: data.email,
      phone: data.phone,
      location: data.location ?? '',
      instagram: data.instagram ?? '',
        privacyPolicyConsent: data.privacyPolicyConsent ?? false,
    },
    TRAINING_CONTACT_VALIDATION
  )
  if (!isValid) {
    return { success: false, error: 'Please fix the form errors and try again.', fieldErrors: errors }
  }

  // D-07: Sanity write -- failure blocks email send, returns generic error
  try {
    await recordTrainingContactSubmission({
      name: data.name,
      email: data.email,
      phone: data.phone,
      location: data.location || undefined,
      instagram: data.instagram || undefined,
      programSlug: data.programSlug,
      programTitle: data.programTitle,
      marketingConsent: data.marketingConsent === true,
      consentText: data.consentText ?? TRAINING_CONTACT_CONSENT_TEXT,
      privacyPolicyConsent: data.privacyPolicyConsent === true,
      sourcePath: data.sourcePath || undefined,
    })
  } catch (err) {
    console.error('[submitTrainingContact] Private DB write failed:', err instanceof Error ? err.message : String(err))
    return { success: false, error: 'Something went wrong, please try again.' }
  }

  const emailResult = await sendSavedFormEmails('training-contact', data, '[submitTrainingContact] Form email delivery failed')

  if (!emailResult.success) {
    return emailResult
  }

  return { success: true }
}

async function sendSavedFormEmails(
  formType: Parameters<typeof sendFormEmails>[0],
  data: Parameters<typeof sendFormEmails>[1],
  logPrefix: string,
): Promise<FormActionResult> {
  try {
    await sendFormEmails(formType, data)
    return { success: true }
  } catch (err) {
    console.error(logPrefix, err instanceof Error ? err.message : String(err))
    return { success: false, error: FORM_EMAIL_FAILURE_MESSAGE }
  }
}
