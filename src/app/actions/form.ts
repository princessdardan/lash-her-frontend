'use server'

import { formClient } from '@/sanity/lib/form-client'
import { sendFormEmails } from '@/lib/email'
import type { GeneralInquiryData, TrainingContactData } from '@/lib/email'
import { validateForm, type FieldValidationConfig } from '@/lib/form-validation'

export interface FormActionResult {
  success: boolean
  error?: string
  fieldErrors?: Record<string, string>
}

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
  location: [{ type: 'required', message: 'Location is required' }],
  instagram: [{ type: 'required', message: 'Instagram handle is required' }],
  experience: [{ type: 'required', message: 'Please select your experience level' }],
  interest: [{ type: 'required', message: 'Please select your training interest' }],
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
    await formClient.create({
      _type: 'generalInquiry',
      name: data.name,
      email: data.email,
      phone: data.phone || undefined,
      instagram: data.instagram || undefined,
      message: data.message,
    })
  } catch (err) {
    console.error('[submitGeneralInquiry] Sanity write failed:', err instanceof Error ? err.message : String(err))
    return { success: false, error: 'Something went wrong, please try again.' }
  }

  // D-06: Email failure is non-blocking -- sendFormEmails never rejects
  // (uses Promise.allSettled internally, logs failures, swallows errors)
  await sendFormEmails('general-inquiry', data)

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
      location: data.location,
      instagram: data.instagram,
      experience: data.experience,
      interest: data.interest,
    },
    TRAINING_CONTACT_VALIDATION
  )
  if (!isValid) {
    return { success: false, error: 'Please fix the form errors and try again.', fieldErrors: errors }
  }

  // D-07: Sanity write -- failure blocks email send, returns generic error
  try {
    await formClient.create({
      _type: 'contactForm',
      name: data.name,
      email: data.email,
      phone: data.phone,
      location: data.location,
      instagram: data.instagram,
      experience: data.experience,
      interest: data.interest,
      clients: data.clients ?? undefined,
      info: data.info || undefined,
    })
  } catch (err) {
    console.error('[submitTrainingContact] Sanity write failed:', err instanceof Error ? err.message : String(err))
    return { success: false, error: 'Something went wrong, please try again.' }
  }

  // D-06: Email failure is non-blocking -- sendFormEmails never rejects
  await sendFormEmails('training-contact', data)

  return { success: true }
}
