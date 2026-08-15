export function mapChitChatsReturnReason(value: string | null | undefined): {
  type: "unclaimed" | "damage" | "return_to_sender";
  cause: string;
} {
  switch (value?.trim().toLowerCase()) {
    case "unclaimed":
      return {
        type: "unclaimed",
        cause: "provider_return_unclaimed_pending_local_inspection",
      };
    case "damaged":
      return {
        type: "damage",
        cause: "provider_return_damaged_pending_local_inspection",
      };
    case "incomplete_address":
      return {
        type: "return_to_sender",
        cause: "provider_return_incomplete_address_pending_local_inspection",
      };
    case "unknown":
      return {
        type: "return_to_sender",
        cause: "provider_return_unknown_pending_local_inspection",
      };
    case "other":
      return {
        type: "return_to_sender",
        cause: "provider_return_other_pending_local_inspection",
      };
    default:
      return {
        type: "return_to_sender",
        cause: "provider_return_unrecognized_pending_local_inspection",
      };
  }
}
