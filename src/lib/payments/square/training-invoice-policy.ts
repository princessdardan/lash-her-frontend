/** Canadian invoices share the same conservative Afterpay ceiling as checkout. */
export {
  SQUARE_AFTERPAY_MIN_CENTS as TRAINING_INVOICE_AFTERPAY_MIN_CENTS,
  SQUARE_AFTERPAY_MAX_CENTS as TRAINING_INVOICE_AFTERPAY_MAX_CENTS,
  SQUARE_AFTERPAY_LIMIT_MESSAGE as TRAINING_INVOICE_AFTERPAY_LIMIT_MESSAGE,
  isSquareAfterpayAmountEligible as isTrainingInvoiceAfterpayAmountEligible,
} from "./afterpay-policy";
