import { AsyncLocalStorage } from "node:async_hooks";

// This context carries the runner's opaque identity and verified scope
// selectors. It does not carry request bodies or credentials.
export type WriterOperationIdentity = Readonly<{
  operationId: string; producerSha256: string; sourceCommit: string; epoch: string;
  kind: "new-work" | "recovery"; targetSha256: string;
}>;
const operationContext = new AsyncLocalStorage<{
  uncertain: boolean; identity?: WriterOperationIdentity; lifecycleSelectionSha256?: string; identityCustomerId?: string;
}>();

export function currentWriterOperationIdentity(): WriterOperationIdentity | undefined {
  return operationContext.getStore()?.identity;
}

export function currentWriterLifecycleSelection(): string | undefined {
  return operationContext.getStore()?.lifecycleSelectionSha256;
}

export function currentWriterIdentityCustomerId(): string | undefined {
  return operationContext.getStore()?.identityCustomerId;
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

export async function withWriterOperationContext<T>(task: () => Promise<T>, identity?: WriterOperationIdentity,
  lifecycleSelectionSha256?: string, identityCustomerId?: string): Promise<T> {
  const operation = { uncertain: false, identity: identity ? Object.freeze({ ...identity }) : undefined,
    lifecycleSelectionSha256, identityCustomerId };
  return operationContext.run(operation, async () => {
    try {
      const result = await task();
      if (operation.uncertain) throw new Error("WRITER_OPERATION_REQUIRES_REVIEW");
      return result;
    } finally {
      operation.lifecycleSelectionSha256 = undefined;
      operation.identityCustomerId = undefined;
    }
  });
}
