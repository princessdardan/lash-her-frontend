export const COURSE_CONSENT_TEXT =
  "I agree to receive lash care tips, service updates, and offers from Lash Her by Nataliea. I can unsubscribe at any time and keep access to this course.";

export const COURSE_ACCESS_SECONDS = 365 * 24 * 60 * 60;

export interface CourseAccessGrant {
  version: 1;
  courseId: string;
  grantId: string;
  expiresAt: number;
}

export interface CourseSignupInput {
  courseId: string;
  email: string;
  marketingConsent: boolean;
  company?: string;
}
