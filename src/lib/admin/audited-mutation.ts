export interface AuditedMutationExecution<T, TTransaction> {
  mutate: (tx: TTransaction) => Promise<T>;
  writeAudit: (tx: TTransaction, result: T) => Promise<void>;
}

export async function executeAuditedMutation<T, TTransaction>(
  transaction: (
    operation: (tx: TTransaction) => Promise<T>,
  ) => Promise<T>,
  execution: AuditedMutationExecution<T, TTransaction>,
): Promise<T> {
  return transaction(async (tx) => {
    const result = await execution.mutate(tx);
    await execution.writeAudit(tx, result);
    return result;
  });
}
