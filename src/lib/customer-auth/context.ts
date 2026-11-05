import { AsyncLocalStorage } from "node:async_hooks";

interface CustomerWriterContext {
  verificationWrites: Map<string, { identifier: string; expiresAt: number; result: Promise<{ identifier: string; token: string; expires: Date }> }>;
}
const customerWriterContext = new AsyncLocalStorage<CustomerWriterContext>();

export function withCustomerWriterContext<T>(task: () => Promise<T>): Promise<T> {
  return customerWriterContext.run({ verificationWrites: new Map() }, task);
}

export function customerVerificationWrites(): CustomerWriterContext["verificationWrites"] {
  const context = customerWriterContext.getStore();
  if (!context) throw new Error("CUSTOMER_AUTH_REQUIRES_ADMISSION");
  return context.verificationWrites;
}

export function assertCustomerWriterContext(): void {
  if (!customerWriterContext.getStore()) throw new Error("CUSTOMER_AUTH_REQUIRES_ADMISSION");
}
