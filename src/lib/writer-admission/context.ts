import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";
import { p2FirstOwnerIdentitySha256 } from "../../../ops/platform/p2-first-owner-identity.mjs";

// This context carries the runner's opaque identity and verified scope
// selectors. It does not carry request bodies or credentials.
export type WriterOperationIdentity = Readonly<{
  operationId: string; producerSha256: string; sourceCommit: string; epoch: string;
  kind: "new-work" | "recovery"; targetSha256: string;
}>;
export type WriterIdentityEnrollment = Readonly<{ provider: "google" | "resend"; nonce: string; emailDigest: string }>;
export type WriterFirstOwner = Readonly<{ nonce: string; identityDigest: string; epoch: string; startedAt: number }>;
export type WriterAuthoringOperation = "create-draft" | "edit-draft" | "reorder-curriculum" | "create-curriculum" | "publish-course"
  | "review-publication" | "save-quiz-revision" | "archive-paid-course" | "republish-paid-course" | "review-paid-restoration";
const operationContext = new AsyncLocalStorage<{
  uncertain: boolean; identity?: WriterOperationIdentity; lifecycleSelectionSha256?: string; identityCustomerId?: string;
  identityEnrollment?: WriterIdentityEnrollment; authoringActorId?: string; authoringOperation?: WriterAuthoringOperation;
  paidAccessActorId?: string; firstOwner?: WriterFirstOwner;
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

export function currentWriterFirstOwner(): WriterFirstOwner | undefined {
  return operationContext.getStore()?.firstOwner;
}

export function matchesWriterFirstOwner(selection: WriterFirstOwner, normalizedEmail: string, providerUserId: string): boolean {
  if (!/^[a-f0-9]{62}$/u.test(selection.identityDigest)) return false;
  const digest = p2FirstOwnerIdentitySha256(selection.nonce, normalizedEmail, providerUserId);
  return digest !== null && timingSafeEqual(Buffer.from(digest.slice(0, 62), "hex"), Buffer.from(selection.identityDigest, "hex"));
}

export function writerFirstOwnerWindowSha256(selection: WriterFirstOwner): string {
  return createHash("sha256").update(JSON.stringify([
    "p2q-first-owner-window-v1", selection.nonce, selection.identityDigest, selection.epoch, selection.startedAt,
  ])).digest("hex");
}

export function currentWriterAuthoringActorId(): string | undefined {
  return operationContext.getStore()?.authoringActorId;
}

export function currentWriterAuthoringOperation(): WriterAuthoringOperation | undefined {
  return operationContext.getStore()?.authoringOperation;
}

export function currentWriterPaidAccessActorId(): string | undefined {
  return operationContext.getStore()?.paidAccessActorId;
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
  authoringActorId?: string, authoringOperation?: WriterAuthoringOperation, paidAccessActorId?: string, firstOwner?: WriterFirstOwner): Promise<T> {
  const operation = { uncertain: false, identity: identity ? Object.freeze({ ...identity }) : undefined,
    lifecycleSelectionSha256, identityCustomerId, authoringActorId, authoringOperation, paidAccessActorId,
    identityEnrollment: identityEnrollment ? Object.freeze({ ...identityEnrollment }) : undefined,
    firstOwner: firstOwner ? Object.freeze({ ...firstOwner }) : undefined };
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
      operation.paidAccessActorId = undefined;
      operation.firstOwner = undefined;
    }
  });
}
