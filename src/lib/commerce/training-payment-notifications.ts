import "server-only";

import {
  claimTrainingPaymentEmails,
  markTrainingEnrollmentStaffAlerted,
  markTrainingEnrollmentStudentPaymentEmailSent,
  recordTrainingPaymentEmailFailure,
} from "@/lib/commerce/training-enrollment-store";
import {
  sendTrainingAdminPaymentEmail,
  sendTrainingCustomerPaymentEmail,
} from "@/lib/commerce/training-payment-email";
import {
  sendTrainingPaymentNotificationEmailsIfNeededWithDependencies,
  type SendTrainingPaymentNotificationEmailsIfNeededInput,
  type TrainingPaymentNotificationDependencies,
} from "@/lib/commerce/training-payment-notification-service";

export type {
  SendTrainingPaymentNotificationEmailsIfNeededInput,
  TrainingPaymentNotificationDependencies,
};

const defaultDependencies: TrainingPaymentNotificationDependencies = {
  claimTrainingPaymentEmails,
  markTrainingEnrollmentStaffAlerted,
  markTrainingEnrollmentStudentPaymentEmailSent,
  recordTrainingPaymentEmailFailure,
  sendTrainingAdminPaymentEmail,
  sendTrainingCustomerPaymentEmail,
};

export async function sendTrainingPaymentNotificationEmailsIfNeeded(
  input: SendTrainingPaymentNotificationEmailsIfNeededInput,
  dependencies: TrainingPaymentNotificationDependencies = defaultDependencies,
): Promise<void> {
  return sendTrainingPaymentNotificationEmailsIfNeededWithDependencies(input, dependencies);
}
