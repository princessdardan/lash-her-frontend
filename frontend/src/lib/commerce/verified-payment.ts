interface VerifiedPaymentPersistenceContext {
  error: string;
  orderId: string;
  transactionId: string;
}

interface PersistVerifiedPaymentInput {
  logError?: (message: string, context: VerifiedPaymentPersistenceContext) => void;
  markPaid: (orderId: string, transactionId: string) => Promise<void>;
  orderId: string;
  transactionId: string;
}

export async function persistVerifiedPayment({
  logError = console.error,
  markPaid,
  orderId,
  transactionId,
}: PersistVerifiedPaymentInput): Promise<boolean> {
  try {
    await markPaid(orderId, transactionId);
    return true;
  } catch (error) {
    logError("[checkout] Verified payment could not be persisted", {
      error: error instanceof Error ? error.message : "Unknown persistence error",
      orderId,
      transactionId,
    });
    return false;
  }
}
