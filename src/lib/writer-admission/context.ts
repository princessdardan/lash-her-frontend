import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";

// This context carries the runner's opaque identity and verified scope
// selectors. It does not carry request bodies or credentials.
export type WriterOperationIdentity = Readonly<{
  operationId: string; producerSha256: string; sourceCommit: string; epoch: string;
  kind: "new-work" | "recovery"; targetSha256: string;
}>;
export type WriterIdentityEnrollment = Readonly<{ provider: "google" | "resend"; nonce: string; emailDigest: string }>;
export type WriterAuthoringOperation = "create-draft" | "edit-draft" | "reorder-curriculum" | "create-curriculum" | "publish-course" | "review-publication" | "save-quiz-revision" | "archive-paid-course";
const operationContext = new AsyncLocalStorage<{
  uncertain: boolean; identity?: WriterOperationIdentity; lifecycleSelectionSha256?: string; identityCustomerId?: string;
  identityEnrollment?: WriterIdentityEnrollment; authoringActorId?: string; authoringOperation?: WriterAuthoringOperation; paidGrantActorId?: string;
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

export function currentWriterIdentityEnrollment(): WriterIdentityEnrollment | undefined {
  return operationContext.getStore()?.identityEnrollment;
}

export function currentWriterAuthoringActorId(): string | undefined {
  return operationContext.getStore()?.authoringActorId;
}

export function currentWriterAuthoringOperation(): WriterAuthoringOperation | undefined {
  return operationContext.getStore()?.authoringOperation;
}

export function currentWriterPaidGrantActorId(): string | undefined {
  return operationContext.getStore()?.paidGrantActorId;
}

export function matchesWriterIdentityEnrollment(selection: WriterIdentityEnrollment, normalizedEmail: string): boolean {
  if (!/^[a-f0-9]{62}$/u.test(selection.emailDigest)) return false;
  const digest = createHash("sha256")
    .update(JSON.stringify(["p2q-customer-enrollment-v1", selection.provider, selection.nonce, normalizedEmail]))
    .digest().subarray(0, 31);
  return timingSafeEqual(digest, Buffer.from(selection.emailDigest, "hex"));
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
  lifecycleSelectionSha256?: string, identityCustomerId?: string, identityEnrollment?: WriterIdentityEnrollment,
  authoringActorId?: string, authoringOperation?: WriterAuthoringOperation, paidGrantActorId?: string): Promise<T> {
  const operation = { uncertain: false, identity: identity ? Object.freeze({ ...identity }) : undefined,
    lifecycleSelectionSha256, identityCustomerId, authoringActorId, authoringOperation, paidGrantActorId,
    identityEnrollment: identityEnrollment ? Object.freeze({ ...identityEnrollment }) : undefined };
  return operationContext.run(operation, async () => {
    try {
      const result = await task();
      if (operation.uncertain) throw new Error("WRITER_OPERATION_REQUIRES_REVIEW");
      return result;
    } finally {
      operation.lifecycleSelectionSha256 = undefined;
      operation.identityCustomerId = undefined;
      operation.identityEnrollment = undefined;
      operation.authoringActorId = undefined;
      operation.authoringOperation = undefined;
      operation.paidGrantActorId = undefined;
    }
  });
}
