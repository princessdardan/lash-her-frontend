export type AdminAppointmentDateBasis = "completed" | "scheduled";

export function resolveAdminAppointmentDateBasis(input: {
  basis: string;
  status: string;
}): AdminAppointmentDateBasis {
  return input.basis === "completed" && input.status === "completed"
    ? "completed"
    : "scheduled";
}
