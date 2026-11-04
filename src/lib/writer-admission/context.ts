import { AsyncLocalStorage } from "node:async_hooks";

// No request data or credentials enter this context. Outside an admitted
// operation the marker is a no-op, preserving existing checkout behavior.
const operationContext = new AsyncLocalStorage<{ uncertain: boolean }>();

export function markWriterOperationUncertain(): void {
  const operation = operationContext.getStore();
  if (operation) operation.uncertain = true;
}

export async function withWriterOperationContext<T>(task: () => Promise<T>): Promise<T> {
  return operationContext.run({ uncertain: false }, async () => {
    const result = await task();
    if (operationContext.getStore()!.uncertain) throw new Error("WRITER_OPERATION_REQUIRES_REVIEW");
    return result;
  });
}
