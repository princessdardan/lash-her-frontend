export type HelcimPayEventOutcome = "success" | "dismissed" | "failed" | "ignored";

export function getHelcimPayEventOutcome(eventStatus: unknown): HelcimPayEventOutcome {
  if (eventStatus === "SUCCESS") return "success";
  if (eventStatus === "ABORTED" || eventStatus === "HIDE") return "dismissed";
  if (typeof eventStatus === "string" && eventStatus.trim().length > 0) return "failed";

  return "ignored";
}
