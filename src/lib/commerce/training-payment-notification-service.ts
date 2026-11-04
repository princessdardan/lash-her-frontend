import { markWriterOperationUncertain } from "@/lib/writer-admission/context";

import type {
  claimTrainingPaymentEmails,
  markTrainingEnrollmentStaffAlerted,
  markTrainingEnrollmentStudentPaymentEmailSent,
  PendingTrainingEnrollmentRecord,
  recordTrainingPaymentEmailFailure,
} from "@/lib/commerce/training-enrollment-store";
import type {
  sendTrainingAdminPaymentEmail,
  sendTrainingCustomerPaymentEmail,
} from "@/lib/commerce/training-payment-email";

export interface SendTrainingPaymentNotificationEmailsIfNeededInput {
  enrollment: PendingTrainingEnrollmentRecord;
  paymentProvider?: "helcim" | "square";
  schedulingUrl: string;
}

export interface TrainingPaymentNotificationDependencies {
  claimTrainingPaymentEmails: typeof claimTrainingPaymentEmails;
  markTrainingEnrollmentStaffAlerted: typeof markTrainingEnrollmentStaffAlerted;
  markTrainingEnrollmentStudentPaymentEmailSent: typeof markTrainingEnrollmentStudentPaymentEmailSent;
  recordTrainingPaymentEmailFailure: typeof recordTrainingPaymentEmailFailure;
  sendTrainingAdminPaymentEmail: typeof sendTrainingAdminPaymentEmail;
  sendTrainingCustomerPaymentEmail: typeof sendTrainingCustomerPaymentEmail;
}

export async function sendTrainingPaymentNotificationEmailsIfNeededWithDependencies(
  input: SendTrainingPaymentNotificationEmailsIfNeededInput,
  dependencies: TrainingPaymentNotificationDependencies,
): Promise<void> {
  if (input.enrollment.studentPaymentEmailSentAt !== null && input.enrollment.staffAlertedAt !== null) {
    return;
  }

  const claimed = await dependencies.claimTrainingPaymentEmails({
    enrollmentId: input.enrollment.enrollmentId,
  });

  if (claimed === null) {
    // Another claim or a concurrent state change is not proof these pending
    // notifications completed. Preserve ordinary callers while refusing drain.
    markWriterOperationUncertain();
    return;
  }

  const errors: string[] = [];
  const emailInput = {
    customerEmail: claimed.checkoutOrder.customerEmail,
    customerName: claimed.checkoutOrder.customerName,
    orderId: claimed.checkoutOrder.orderId,
    paymentProvider: input.paymentProvider,
    programTitle: claimed.programSnapshot.title,
    schedulingUrl: input.schedulingUrl,
  };

  if (claimed.studentPaymentEmailSentAt === null) {
    try {
      await dependencies.sendTrainingCustomerPaymentEmail(emailInput);
      const recorded = await dependencies.markTrainingEnrollmentStudentPaymentEmailSent({
        enrollmentId: claimed.enrollmentId,
      });
      if (!recorded) markWriterOperationUncertain();
    } catch (error) {
      errors.push(`customer: ${getErrorMessage(error)}`);
    }
  }

  if (claimed.staffAlertedAt === null) {
    try {
      await dependencies.sendTrainingAdminPaymentEmail(emailInput);
      const recorded = await dependencies.markTrainingEnrollmentStaffAlerted({
        enrollmentId: claimed.enrollmentId,
      });
      if (!recorded) markWriterOperationUncertain();
    } catch (error) {
      errors.push(`admin: ${getErrorMessage(error)}`);
    }
  }

  if (errors.length > 0) {
    const message = errors.join("; ");
    await dependencies.recordTrainingPaymentEmailFailure({
      enrollmentId: claimed.enrollmentId,
      error: message,
    });
    throw new Error(message);
  }

}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown email error";
}
