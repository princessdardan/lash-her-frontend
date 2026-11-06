import { AsyncLocalStorage } from "node:async_hooks";

// Only the runner's opaque admission identity enters this context, never request
// data or credentials. Outside admission the uncertainty marker remains a no-op.
export type WriterOperationIdentity = Readonly<{
  operationId: string; producerSha256: string; sourceCommit: string; epoch: string;
  kind: "new-work" | "recovery"; targetSha256: string;
}>;
const operationContext = new AsyncLocalStorage<{ uncertain: boolean; identity?: WriterOperationIdentity }>();

export function currentWriterOperationIdentity(): WriterOperationIdentity | undefined {
  return operationContext.getStore()?.identity;
}

export function markWriterOperationUncertain(): void {
  const operation = operationContext.getStore();
  if (operation) operation.uncertain = true;
}

export function assertWriterOperationCertain(): void {
  if (operationContext.getStore()?.uncertain) {
    throw new Error("WRITER_OPERATION_REQUIRES_REVIEW");
  }
}

export async function withWriterOperationContext<T>(task: () => Promise<T>, identity?: WriterOperationIdentity): Promise<T> {
  return operationContext.run({ uncertain: false, identity: identity ? Object.freeze({ ...identity }) : undefined }, async () => {
    const result = await task();
    if (operationContext.getStore()!.uncertain) throw new Error("WRITER_OPERATION_REQUIRES_REVIEW");
    return result;
  });
}
