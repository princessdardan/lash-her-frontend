import { AsyncLocalStorage } from "node:async_hooks";

const customerWriterContext = new AsyncLocalStorage<boolean>();

export function withCustomerWriterContext<T>(task: () => Promise<T>): Promise<T> {
  return customerWriterContext.run(true, task);
}

export function assertCustomerWriterContext(): void {
  if (!customerWriterContext.getStore()) throw new Error("CUSTOMER_AUTH_REQUIRES_ADMISSION");
}
