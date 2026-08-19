export type ShipmentOperationStatus =
  | "queued"
  | "processing"
  | "retryable_failed"
  | "succeeded"
  | "dead_letter";

export function isTerminalShipmentOperationStatus(
  status: ShipmentOperationStatus,
): boolean {
  return status === "succeeded" || status === "dead_letter";
}
